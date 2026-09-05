import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKey } from '@pomagierkb/shared/db';
import {
  makeHarness,
  makeUser,
  mcpModernRequest,
  mcpRequest,
  initializeBody,
  toolsListBody,
  type TestHarness,
} from './helpers.js';

/**
 * Era protokołu 2026-07-28 (SDK v2, routing user-land): server/discover,
 * resultType, cache hints, serverInfo w _meta, walidacja Mcp-Method (-32020),
 * auth PRZED SDK, oraz WSPÓŁISTNIENIE z legacy 2025 na tym samym endpoincie.
 */

let h: TestHarness;
let raw: string;

interface RpcResponse {
  result?: Record<string, unknown> & { _meta?: Record<string, unknown> };
  error?: { code: number; message: string };
}

beforeAll(() => {
  h = makeHarness();
  const userId = makeUser(h.db, 'usr_modern');
  raw = createKey(h.db, userId, 'k-modern', ['read'], 'default', 30).raw;
});
afterAll(async () => {
  await h.close();
});

describe('era 2026-07-28', () => {
  it('server/discover: supportedVersions, capabilities, serverInfo w _meta', async () => {
    const res = await mcpModernRequest(h.bundle.app, 'default', raw, 'server/discover');
    expect(res.statusCode).toBe(200);
    const body = res.json() as RpcResponse;
    expect(body.result?.['supportedVersions']).toContain('2026-07-28');
    expect(body.result?.['resultType']).toBe('complete');
    expect(body.result?._meta?.['io.modelcontextprotocol/serverInfo']).toMatchObject({
      name: 'pomagierkb',
    });
  });

  it('modern tools/list: resultType complete + ttlMs 60000 + cacheScope private + surowe schematy', async () => {
    const res = await mcpModernRequest(h.bundle.app, 'default', raw, 'tools/list');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const result = (res.json() as RpcResponse).result!;
    expect(result['resultType']).toBe('complete');
    expect(result['ttlMs']).toBe(60_000);
    expect(result['cacheScope']).toBe('private');
    const tools = result['tools'] as { name: string; inputSchema: Record<string, unknown> }[];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]?.inputSchema['additionalProperties']).toBe(false);
  });

  it('modern tools/call z nagłówkiem Mcp-Name; wynik stampowany resultType', async () => {
    const res = await mcpModernRequest(h.bundle.app, 'default', raw, 'tools/call', {
      name: 'kb_list',
      arguments: {},
    }, { mcpName: 'kb_list' });
    expect(res.statusCode).toBe(200);
    const result = (res.json() as RpcResponse).result!;
    expect(result['resultType']).toBe('complete');
    expect(result['structuredContent']).toEqual({ kbs: [] });
  });

  it('Mcp-Method niezgodny z body → 400 + HeaderMismatch -32020', async () => {
    const res = await mcpModernRequest(h.bundle.app, 'default', raw, 'tools/list', {}, {
      mcpMethodHeader: 'tools/call',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as RpcResponse).error?.code).toBe(-32020);
  });

  it('auth PRZED SDK na ścieżce modern: brak tokenu → 401 (-32001)', async () => {
    const res = await mcpModernRequest(h.bundle.app, 'default', null, 'tools/list');
    expect(res.statusCode).toBe(401);
    expect((res.json() as RpcResponse).error?.code).toBe(-32001);
  });

  it('WSPÓŁISTNIENIE: legacy initialize na tym samym endpoincie dalej działa (2025)', async () => {
    const init = await mcpRequest(h.bundle.app, 'default', raw, initializeBody());
    expect(init.statusCode).toBe(200);
    const list = await mcpRequest(h.bundle.app, 'default', raw, toolsListBody());
    expect(list.statusCode).toBe(200);
    expect(list.headers['content-type']).toContain('application/json'); // ścieżka v1 bez zmian
    const result = (list.json() as RpcResponse).result!;
    expect(result['resultType']).toBeUndefined(); // era 2025: bez pól 2026
    expect(result['ttlMs']).toBeUndefined();
  });
});
