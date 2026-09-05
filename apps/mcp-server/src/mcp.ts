import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { AppError } from '@pomagierkb/shared/errors';
import type { KbTool, ToolCtx, ToolResult } from './tools/types.js';
import { hasWriteScope, toolRequiresWrite } from './profiles.js';
import { validateInput } from './validate.js';
import { ALL_PROMPTS } from './prompts.js';
import {
  createMcpHandler,
  McpServer as McpServerV2,
  ProtocolError as ProtocolErrorV2,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
export { isLegacyRequest } from '@modelcontextprotocol/server';
export { toNodeHandler } from '@modelcontextprotocol/node';

/**
 * Fabryka McpServer per żądanie (§7.1): StreamableHTTPServerTransport bezstanowy
 * (sessionIdGenerator: undefined, enableJsonResponse: true). Używamy NISKOPOZIOMOWEGO
 * Server + setRequestHandler, żeby tools/list zwracał DOKŁADNIE surowe
 * inputSchema/outputSchema/annotations z definicji KbTool — bez konwersji zod.
 */

// Kody JSON-RPC przyjęte w projekcie (poza standardowymi -32600..-32603):
export const JSONRPC_RATE_LIMITED = -32000;
export const JSONRPC_UNAUTHORIZED = -32001;
export const JSONRPC_FORBIDDEN = -32003;

export interface UsageEvent {
  tool: string;
  namespaces: string[];
  tookMs: number;
  confidence?: number;
  degraded?: boolean;
}

export interface McpPairOptions {
  ctx: ToolCtx;
  /** Pełna lista narzędzi procesu; widoczność przycinana do profilu z ctx. */
  tools: KbTool[];
  /** Limit per narzędzie (kb_answer 10/min); brak = bez limitu narzędziowego. */
  checkToolRateLimit?: (toolName: string) => { ok: boolean; retryAfter: number };
  /** Wpis do usage-JSONL po każdym tools/call (poza łańcuchem audytu). */
  onUsage?: (event: UsageEvent) => void;
  serverName?: string;
  serverVersion?: string;
}

/** Mapowanie AppError → errorCode wyniku narzędzia (§7.4: błędy jako isError, nie protokół). */
function toolErrorCode(err: unknown): string {
  if (err instanceof AppError) {
    switch (err.code) {
      case 'upstream_error':
      case 'upstream_timeout':
      case 'not_ready':
        return 'upstream_unavailable';
      case 'rate_limited':
        return 'rate_limited';
      case 'validation_error':
        return 'validation';
      default:
        return 'internal';
    }
  }
  return 'internal';
}

/** Wynik narzędzia → kształt CallToolResult (content + structuredContent + isError). */
function toCallToolResult(out: ToolResult): ServerResult {
  const result: Record<string, unknown> = { content: [{ type: 'text', text: out.text }] };
  if (typeof out.structured === 'object' && out.structured !== null) {
    result.structuredContent = out.structured;
  }
  if (out.isError === true) result.isError = true;
  return result as ServerResult;
}

/** namespaces do usage-logu: z wejścia narzędzia, inaczej cały dozwolony zbiór. */
function usageNamespaces(input: unknown, ctx: ToolCtx): string[] {
  if (typeof input === 'object' && input !== null) {
    const ns = (input as Record<string, unknown>).namespaces;
    if (Array.isArray(ns) && ns.every((n) => typeof n === 'string')) return ns as string[];
  }
  return ctx.allowedNamespaces;
}

/** Widoczne narzędzia = ALL_TOOLS ∩ tools_json profilu (kontrakt tools/list — test w CI). */
export function visibleToolsFor(opts: McpPairOptions): KbTool[] {
  let allowed: string[] = [];
  try {
    allowed = JSON.parse(opts.ctx.profile.tools_json) as string[];
  } catch {
    allowed = [];
  }
  const set = new Set(allowed);
  return opts.tools.filter((t) => set.has(t.name));
}

/** Payload tools/list — SUROWE schematy z KbTool, identyczne w obu erach protokołu. */
export function toolsListPayload(visible: KbTool[]): Record<string, unknown> {
  return {
    tools: visible.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    })),
  };
}

/** Wynik wspólnej ścieżki tools/call: błąd protokołu (era mapuje na swoją klasę) albo ToolResult. */
export type ToolCallOutcome =
  | { kind: 'protocolError'; code: number; message: string; data?: Record<string, unknown> }
  | { kind: 'result'; result: ToolResult };

/**
 * WSPÓLNA logika tools/call dla obu er protokołu (2025 przez SDK v1 i 2026 przez
 * v2): whitelist profilu, bramka write, limit narzędziowy, walidacja wejścia,
 * błędy narzędzi jako isError + usage-log. Semantyka kodów bez zmian.
 */
export async function executeToolCall(
  opts: McpPairOptions,
  visible: KbTool[],
  name: string,
  input: unknown,
): Promise<ToolCallOutcome> {
  const { ctx } = opts;
  const tool = visible.find((t) => t.name === name);
  if (tool === undefined) {
    // spoza whitelisty profilu lub nieistniejące — nierozróżnialne dla klienta
    return { kind: 'protocolError', code: -32601, message: `nieznane narzędzie: ${name}` };
  }
  if (toolRequiresWrite(tool) && !hasWriteScope(ctx.scopes)) {
    return {
      kind: 'protocolError',
      code: JSONRPC_FORBIDDEN,
      message: `forbidden: narzędzie ${name} wymaga scope write`,
    };
  }
  const rl = opts.checkToolRateLimit?.(name);
  if (rl !== undefined && !rl.ok) {
    return {
      kind: 'protocolError',
      code: JSONRPC_RATE_LIMITED,
      message: 'rate_limited',
      data: { retryAfter: rl.retryAfter },
    };
  }

  const problems = validateInput(tool.inputSchema, input);
  if (problems.length > 0) {
    return {
      kind: 'result',
      result: {
        structured: { errorCode: 'validation', problems },
        text: `Nieprawidłowe wejście narzędzia ${name}: ${problems.join('; ')}`,
        isError: true,
      },
    };
  }

  const started = Date.now();
  let out: ToolResult;
  try {
    out = await tool.handler(ctx, input);
  } catch (err) {
    // §7.4: błędy narzędzi jako isError, nie błędy protokołu
    ctx.log.error(
      { tool: name, err: err instanceof Error ? err.message : String(err) },
      'mcp: narzędzie rzuciło wyjątek',
    );
    out = {
      structured: { errorCode: toolErrorCode(err) },
      text: `Błąd narzędzia ${name}: ${err instanceof Error ? err.message : 'nieznany błąd'}`,
      isError: true,
    };
  }
  const tookMs = Date.now() - started;

  const structured =
    typeof out.structured === 'object' && out.structured !== null
      ? (out.structured as Record<string, unknown>)
      : {};
  opts.onUsage?.({
    tool: name,
    namespaces: usageNamespaces(input, ctx),
    tookMs,
    ...(typeof structured.confidence === 'number' ? { confidence: structured.confidence } : {}),
    ...(typeof structured.degraded === 'boolean' ? { degraded: structured.degraded } : {}),
  });

  return { kind: 'result', result: out };
}

export function createMcpPair(opts: McpPairOptions): {
  server: Server;
  transport: StreamableHTTPServerTransport;
} {
  const { ctx } = opts;
  const visible = visibleToolsFor(opts);
  const allowed = new Set(visible.map((t) => t.name));

  // Prompty widoczne dla profili z odczytem (kb_search) — workflow, nie dane.
  const promptsVisible = allowed.has('kb_search');
  const server = new Server(
    { name: opts.serverName ?? 'pomagierkb', version: opts.serverVersion ?? ctx.config.version },
    { capabilities: { tools: {}, ...(promptsVisible ? { prompts: {} } : {}) } },
  );

  if (promptsVisible) {
    server.setRequestHandler(ListPromptsRequestSchema, () => {
      return {
        prompts: ALL_PROMPTS.map((p) => ({
          name: p.name,
          title: p.title,
          description: p.description,
          arguments: p.arguments,
        })),
      } as unknown as ServerResult;
    });
    server.setRequestHandler(GetPromptRequestSchema, (request) => {
      const prompt = ALL_PROMPTS.find((p) => p.name === request.params.name);
      if (prompt === undefined) {
        throw new McpError(ErrorCode.MethodNotFound, `nieznany prompt: ${request.params.name}`);
      }
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.params.arguments ?? {})) {
        if (typeof v === 'string') args[k] = v;
      }
      const missing = prompt.arguments.filter((a) => a.required && (args[a.name] ?? '') === '');
      if (missing.length > 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `brak wymaganych argumentów promptu: ${missing.map((a) => a.name).join(', ')}`,
        );
      }
      return {
        description: prompt.description,
        messages: [{ role: 'user', content: { type: 'text', text: prompt.render(args) } }],
      } as unknown as ServerResult;
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return toolsListPayload(visible) as unknown as ServerResult;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ServerResult> => {
    const outcome = await executeToolCall(opts, visible, request.params.name, request.params.arguments ?? {});
    if (outcome.kind === 'protocolError') {
      throw new McpError(outcome.code as ErrorCode, outcome.message, outcome.data);
    }
    return toCallToolResult(outcome.result);
  });

  // cast: exactOptionalPropertyTypes vs typ opcji SDK (sessionIdGenerator?: () => string);
  // jawne `undefined` = tryb bezstanowy wg dokumentacji SDK
  const transportOptions = {
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0];
  const transport = new StreamableHTTPServerTransport(transportOptions);

  return { server, transport };
}


/**
 * ERA 2026-07-28 (SDK v2): handler modern-only (legacy:'reject' — ruch 2025 jest
 * routowany user-land przez isLegacyRequest do ścieżki v1 wyżej, DOKŁADNIE po to,
 * by zachować bajtową zgodność z dzisiejszymi klientami; wzorzec z dokumentacji
 * SDK). SDK sam: server/discover, resultType, serverInfo w _meta, walidacja
 * Mcp-Method/Mcp-Name (-32020). My: te same handlery tools/prompts co w v1
 * (wspólne executeToolCall/toolsListPayload) + cache hints tools/list
 * (ttlMs 60 s = TTL cache profili, cacheScope private — dane per klucz).
 */
export function createModernHandler(opts: McpPairOptions): McpHttpHandler {
  const { ctx } = opts;
  const visible = visibleToolsFor(opts);
  const promptsVisible = visible.some((t) => t.name === 'kb_search');

  return createMcpHandler(
    () => {
      const mcp = new McpServerV2(
        { name: opts.serverName ?? 'pomagierkb', version: opts.serverVersion ?? ctx.config.version },
        {
          capabilities: { tools: {}, ...(promptsVisible ? { prompts: {} } : {}) },
          cacheHints: {
            'tools/list': { ttlMs: 60_000, cacheScope: 'private' },
            ...(promptsVisible ? { 'prompts/list': { ttlMs: 60_000, cacheScope: 'private' } } : {}),
          },
        },
      );
      mcp.server.setRequestHandler('tools/list', async () => toolsListPayload(visible) as never);
      mcp.server.setRequestHandler('tools/call', async (request) => {
        const params = request.params as { name: string; arguments?: unknown };
        const outcome = await executeToolCall(opts, visible, params.name, params.arguments ?? {});
        if (outcome.kind === 'protocolError') {
          throw new ProtocolErrorV2(outcome.code, outcome.message, outcome.data);
        }
        return toCallToolResult(outcome.result) as never;
      });
      if (promptsVisible) {
        mcp.server.setRequestHandler('prompts/list', async () => {
          return {
            prompts: ALL_PROMPTS.map((p) => ({
              name: p.name,
              title: p.title,
              description: p.description,
              arguments: p.arguments,
            })),
          } as never;
        });
        mcp.server.setRequestHandler('prompts/get', async (request) => {
          const params = request.params as { name: string; arguments?: Record<string, unknown> };
          const prompt = ALL_PROMPTS.find((p) => p.name === params.name);
          if (prompt === undefined) {
            throw new ProtocolErrorV2(-32601, `nieznany prompt: ${params.name}`);
          }
          const args: Record<string, string> = {};
          for (const [k, v] of Object.entries(params.arguments ?? {})) {
            if (typeof v === 'string') args[k] = v;
          }
          const missing = prompt.arguments.filter((a) => a.required && (args[a.name] ?? '') === '');
          if (missing.length > 0) {
            throw new ProtocolErrorV2(
              -32602,
              `brak wymaganych argumentów promptu: ${missing.map((a) => a.name).join(', ')}`,
            );
          }
          return {
            description: prompt.description,
            messages: [{ role: 'user', content: { type: 'text', text: prompt.render(args) } }],
          } as never;
        });
      }
      return mcp;
    },
    {
      legacy: 'reject', // ruch 2025 nigdy tu nie trafia — patrz routing w server.ts
      responseMode: 'json',
      onerror: (err) => ctx.log.error({ err: err.message }, 'mcp(v2): błąd handlera'),
    },
  );
}
