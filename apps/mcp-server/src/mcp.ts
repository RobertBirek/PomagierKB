import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import { AppError } from '@pomagierkb/shared/errors';
import type { KbTool, ToolCtx, ToolResult } from './tools/types.js';
import { hasWriteScope, toolRequiresWrite } from './profiles.js';
import { validateInput } from './validate.js';

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

export function createMcpPair(opts: McpPairOptions): {
  server: Server;
  transport: StreamableHTTPServerTransport;
} {
  const { ctx } = opts;
  const allowed = new Set(
    // whitelist profilu: tools_json — kontrakt tools/list == profil (test w CI)
    ((): string[] => {
      try {
        return JSON.parse(ctx.profile.tools_json) as string[];
      } catch {
        return [];
      }
    })(),
  );
  const visible = opts.tools.filter((t) => allowed.has(t.name));

  const server = new Server(
    { name: opts.serverName ?? 'pomagierkb', version: opts.serverVersion ?? ctx.config.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return {
      tools: visible.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
        annotations: t.annotations,
      })),
    } as unknown as ServerResult;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ServerResult> => {
    const name = request.params.name;
    const tool = visible.find((t) => t.name === name);
    if (tool === undefined) {
      // spoza whitelisty profilu lub nieistniejące — nierozróżnialne dla klienta
      throw new McpError(ErrorCode.MethodNotFound, `nieznane narzędzie: ${name}`);
    }
    if (toolRequiresWrite(tool) && !hasWriteScope(ctx.scopes)) {
      throw new McpError(JSONRPC_FORBIDDEN, `forbidden: narzędzie ${name} wymaga scope write`);
    }
    const rl = opts.checkToolRateLimit?.(name);
    if (rl !== undefined && !rl.ok) {
      throw new McpError(JSONRPC_RATE_LIMITED, 'rate_limited', { retryAfter: rl.retryAfter });
    }

    const input: unknown = request.params.arguments ?? {};
    const problems = validateInput(tool.inputSchema, input);
    if (problems.length > 0) {
      return toCallToolResult({
        structured: { errorCode: 'validation', problems },
        text: `Nieprawidłowe wejście narzędzia ${name}: ${problems.join('; ')}`,
        isError: true,
      });
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

    return toCallToolResult(out);
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
