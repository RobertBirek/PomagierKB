import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKey } from '@pomagierkb/shared/db';
import {
  initializeBody,
  makeHarness,
  makeUser,
  mcpRequest,
  stubListTool,
  toolsCallBody,
  toolsListBody,
  type TestHarness,
} from './helpers.js';

/** Transport Streamable HTTP stateless: initialize + tools/list + tools/call przez inject. */

describe('shell MCP: transport i kontrakt tools/list', () => {
  let h: TestHarness;
  let rawKey: string;

  beforeEach(() => {
    h = makeHarness();
    const userId = makeUser(h.db);
    rawKey = createKey(h.db, userId, 'test', ['read'], 'default', 30).raw;
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('initialize zwraca serverInfo i protocolVersion (JSON, nie SSE)', async () => {
    const res = await mcpRequest(h.bundle.app, 'default', rawKey, initializeBody());
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json() as {
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: object };
    };
    expect(body.result.serverInfo.name).toBe('pomagierkb');
    expect(typeof body.result.protocolVersion).toBe('string');
    expect(body.result.capabilities).toHaveProperty('tools');
  });

  it('tools/list zwraca DOKŁADNIE surowe schematy i adnotacje z KbTool, przycięte do profilu', async () => {
    // profil default: kb_search, kb_answer, kb_list, kb_feedback — z wstrzykniętych
    // stubów (kb_list + kb_submit_draft) widoczny jest tylko kb_list
    const res = await mcpRequest(h.bundle.app, 'default', rawKey, toolsListBody());
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      result: {
        tools: {
          name: string;
          title: string;
          description: string;
          inputSchema: object;
          outputSchema: object;
          annotations: object;
        }[];
      };
    };
    expect(body.result.tools.map((t) => t.name)).toEqual(['kb_list']);
    const tool = body.result.tools[0]!;
    expect(tool.title).toBe(stubListTool.title);
    expect(tool.description).toBe(stubListTool.description);
    expect(tool.inputSchema).toEqual(stubListTool.inputSchema);
    expect(tool.outputSchema).toEqual(stubListTool.outputSchema);
    expect(tool.annotations).toEqual(stubListTool.annotations);
  });

  it('tools/call zwraca content + structuredContent z wyniku narzędzia', async () => {
    const res = await mcpRequest(h.bundle.app, 'default', rawKey, toolsCallBody('kb_list'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      result: { content: { type: string; text: string }[]; structuredContent: unknown; isError?: boolean };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]).toEqual({ type: 'text', text: 'Brak baz (stub).' });
    expect(body.result.structuredContent).toEqual({ kbs: [] });
  });

  it('nieprawidłowe wejście → wynik isError z errorCode validation (nie błąd protokołu)', async () => {
    const res = await mcpRequest(
      h.bundle.app,
      'default',
      rawKey,
      toolsCallBody('kb_list', { nieznanePole: 1 }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      result: { isError?: boolean; structuredContent: { errorCode: string } };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.errorCode).toBe('validation');
  });

  it('narzędzie spoza profilu / nieistniejące → JSON-RPC -32601', async () => {
    // kb_submit_draft NIE jest w tools_json profilu default
    const res1 = await mcpRequest(h.bundle.app, 'default', rawKey, toolsCallBody('kb_submit_draft'));
    expect((res1.json() as { error: { code: number } }).error.code).toBe(-32601);
    const res2 = await mcpRequest(h.bundle.app, 'default', rawKey, toolsCallBody('nie_ma_takiego'));
    expect((res2.json() as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('GET i DELETE /mcp/* → 405 z nagłówkiem Allow: POST', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await h.bundle.app.inject({ method, url: '/mcp/default' });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });

  it('/healthz i /readyz odpowiadają (readyz ok: profil default enabled + migracje)', async () => {
    const health = await h.bundle.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect((health.json() as { ok: boolean }).ok).toBe(true);

    const ready = await h.bundle.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    const body = ready.json() as {
      ok: boolean;
      checks: { db: boolean; migrations: boolean; profilesEnabled: boolean; searchProbe: unknown };
    };
    expect(body.ok).toBe(true);
    expect(body.checks).toMatchObject({ db: true, migrations: true, profilesEnabled: true });
    expect(body.checks.searchProbe).toBeNull(); // openspg wyłączony w teście
  });

  it('write-gate NIE blokuje odczytu, a klucz write przechodzi przez narzędzie write', async () => {
    const userId = makeUser(h.db, 'usr_writer');
    // profil z narzędziem write w tools_json
    const { createProfile } = await import('@pomagierkb/shared/db');
    createProfile(h.db, {
      id: 'writer',
      name: 'Writer',
      tools: ['kb_list', 'kb_submit_draft'],
    });
    const writeKey = createKey(h.db, userId, 'w', ['read', 'write'], 'writer', 30).raw;
    const res = await mcpRequest(h.bundle.app, 'writer', writeKey, toolsCallBody('kb_submit_draft'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { result: { structuredContent: { draftId: string } } };
    expect(body.result.structuredContent.draftId).toBe('draft_stub');
    // stub write zostawia wpis w usage-JSONL — sprawdź katalog
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(`${h.dir}/mcp-usage`);
    expect(files.length).toBeGreaterThan(0);
  });
});
