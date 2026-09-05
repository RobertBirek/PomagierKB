import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { nowIso, openDb, runMigrations, type Db } from '@pomagierkb/shared/db';
import { buildServer, type BuildServerOptions, type McpServerBundle } from '../src/server.js';
import { loadConfig, sharedMigrationsDir, type McpConfig } from '../src/config.js';
import type { KbTool } from '../src/tools/types.js';

/** Pomocniki testów shellu mcp-server (bez implementacji narzędzi kb_* — stuby). */

export const INTERNAL_TOKEN = 'itest-internal-secret';

export function makeDb(): Db {
  const db = openDb(':memory:');
  runMigrations(db, sharedMigrationsDir());
  return db;
}

export function makeUser(db: Db, id = 'usr_test'): string {
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, sub, email, display_name, kind, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'oidc', 'operator', 'active', ?, ?)`,
  ).run(id, `sub-${id}`, `${id}@example.com`, id, now, now);
  return id;
}

export function testConfig(dataDir: string, extra: Record<string, string> = {}): McpConfig {
  return loadConfig({ DATA_DIR: dataDir, INTERNAL_TOKEN, ...extra } as NodeJS.ProcessEnv);
}

export interface TestHarness {
  db: Db;
  config: McpConfig;
  bundle: McpServerBundle;
  dir: string;
  cleanup(): Promise<void>;
}

export function makeHarness(
  opts: { tools?: KbTool[]; env?: Record<string, string> } & Partial<BuildServerOptions> = {},
): TestHarness {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-shell-test-'));
  const db = opts.db ?? makeDb();
  const config = opts.config ?? testConfig(dir, opts.env ?? {});
  const bundle = buildServer({
    db,
    config,
    openspg: opts.openspg !== undefined ? opts.openspg : null,
    llmProvider: opts.llmProvider ?? (() => null),
    tools: opts.tools ?? [stubListTool, stubSubmitTool],
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return {
    db,
    config,
    bundle,
    dir,
    cleanup: async () => {
      await bundle.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── Stuby narzędzi (shell testowany bez implementacji kb_*) ──────────────────

export const stubListTool: KbTool = {
  name: 'kb_list',
  title: 'Lista baz wiedzy (stub)',
  description: 'Stub narzędzia tylko-do-odczytu do testów shellu.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['kbs'],
    properties: { kbs: { type: 'array', items: { type: 'object' } } },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async () => ({ structured: { kbs: [] }, text: 'Brak baz (stub).' }),
};

export const stubSubmitTool: KbTool = {
  name: 'kb_submit_draft',
  title: 'Zgłoś szkic (stub)',
  description: 'Stub narzędzia write do testu bramki scope.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['draftId', 'status', 'reviewRequired'],
    properties: {
      draftId: { type: 'string' },
      status: { type: 'string' },
      reviewRequired: { type: 'boolean' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: async () => ({
    structured: { draftId: 'draft_stub', status: 'inbox', reviewRequired: true },
    text: 'Szkic przyjęty (stub).',
  }),
};

// ── Żądania MCP przez inject ─────────────────────────────────────────────────

export const MCP_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

export function initializeBody(id = 1): object {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.0' },
    },
  };
}

export function toolsListBody(id = 2): object {
  return { jsonrpc: '2.0', id, method: 'tools/list' };
}

export function toolsCallBody(name: string, args: object = {}, id = 3): object {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

export async function mcpRequest(
  app: FastifyInstance,
  profileId: string,
  key: string | null,
  body: object,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  return app.inject({
    method: 'POST',
    url: `/mcp/${profileId}`,
    headers,
    payload: body,
  } satisfies InjectOptions);
}


// ── Era 2026-07-28: envelope _meta + wymagane nagłówki Mcp-* ─────────────────

export const MODERN_META: Record<string, unknown> = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'vitest-modern', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

export function modernBody(method: string, params: object = {}, id = 10): object {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: MODERN_META } };
}

export async function mcpModernRequest(
  app: FastifyInstance,
  profileId: string,
  key: string | null,
  method: string,
  params: object = {},
  opts: { mcpMethodHeader?: string; mcpName?: string; id?: number } = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'mcp-method': opts.mcpMethodHeader ?? method,
    ...(opts.mcpName !== undefined ? { 'mcp-name': opts.mcpName } : {}),
  };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  return app.inject({
    method: 'POST',
    url: `/mcp/${profileId}`,
    headers,
    payload: modernBody(method, params, opts.id ?? 10),
  } satisfies InjectOptions);
}
