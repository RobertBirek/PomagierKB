import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKey, createProfile } from '@pomagierkb/shared/db';
import {
  makeHarness,
  makeUser,
  mcpModernRequest,
  mcpRequest,
  toolsCallBody,
  type TestHarness,
} from './helpers.js';
import type { KbTool } from '../src/tools/types.js';

/**
 * D9-01: batch JSON-RPC ery 2025 (SDK v1 wykonuje KAŻDĄ wiadomość tablicy) musi
 * kosztować limiter tyle, ile wywołań zawiera — inaczej uwierzytelniony klient
 * robi N-krotność udokumentowanych 60/min jednym POST-em. Plus limity narzędziowe
 * dla wywołań płacących LLM/OpenSPG (kb_answer, kb_claim_verify, kb_search vector).
 */

const GLOBAL_LIMIT = 60;

/** Stub o dowolnej nazwie z whitelisty — shell testujemy bez implementacji kb_*. */
function stubTool(name: string): KbTool {
  return {
    name,
    title: `Stub ${name}`,
    description: 'Stub narzędzia tylko-do-odczytu do testów limitów.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { mode: { type: 'string', enum: ['hybrid', 'text', 'vector'] } },
    },
    outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async () => ({ structured: { ok: true }, text: 'ok' }),
  };
}

interface RpcError {
  error?: { code: number; message: string; data?: { retryAfter?: number } };
  result?: Record<string, unknown>;
}

/** N wiadomości tools/call w JEDNYM POST (tablica JSON-RPC — legalna w erze 2025). */
function batch(n: number, name = 'kb_list'): object[] {
  return Array.from({ length: n }, (_, i) => toolsCallBody(name, {}, 1000 + i));
}

describe('limiter globalny: batch liczony per wywołanie, nie per żądanie HTTP', () => {
  let h: TestHarness;
  let raw: string;

  beforeEach(() => {
    h = makeHarness({ tools: [stubTool('kb_list')] });
    const userId = makeUser(h.db, 'usr_batch');
    raw = createKey(h.db, userId, 'k-batch', ['read'], 'default', 30).raw;
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('batch 3× tools/call wykonuje się (3 wyniki) i kosztuje DOKŁADNIE 3 jednostki', async () => {
    const res = await mcpRequest(h.bundle.app, 'default', raw, batch(3));
    expect(res.statusCode).toBe(200);
    const body = res.json() as RpcError[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);

    // pozostało 57 jednostek: batch 58 się nie mieści (i nie konsumuje okna)…
    const tooBig = await mcpRequest(h.bundle.app, 'default', raw, batch(GLOBAL_LIMIT - 2));
    expect(tooBig.statusCode).toBe(429);
    expect((tooBig.json() as RpcError).error?.code).toBe(-32000);

    // …a batch 57 domyka okno co do jednostki
    const exact = await mcpRequest(h.bundle.app, 'default', raw, batch(GLOBAL_LIMIT - 3));
    expect(exact.statusCode).toBe(200);
    expect(exact.json() as RpcError[]).toHaveLength(GLOBAL_LIMIT - 3);

    // 61. jednostka → 429 z retry-after
    const over = await mcpRequest(h.bundle.app, 'default', raw, toolsCallBody('kb_list'));
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
  });

  it('batch większy niż całe okno → 429 i ANI JEDNO narzędzie nie jest wykonane', async () => {
    let calls = 0;
    const counting = stubTool('kb_list');
    counting.handler = async () => {
      calls += 1;
      return { structured: { ok: true }, text: 'ok' };
    };
    await h.cleanup();
    h = makeHarness({ tools: [counting] });
    const userId = makeUser(h.db, 'usr_batch2');
    raw = createKey(h.db, userId, 'k2', ['read'], 'default', 30).raw;

    const res = await mcpRequest(h.bundle.app, 'default', raw, batch(GLOBAL_LIMIT + 1));
    expect(res.statusCode).toBe(429);
    expect(calls).toBe(0);
  });

  it('pojedyncze wywołania: 60 przechodzi, 61. → 429 (regresja na zwykłą ścieżkę)', async () => {
    for (let i = 0; i < GLOBAL_LIMIT; i++) {
      const ok = await mcpRequest(h.bundle.app, 'default', raw, toolsCallBody('kb_list'));
      expect(ok.statusCode).toBe(200);
    }
    const over = await mcpRequest(h.bundle.app, 'default', raw, toolsCallBody('kb_list'));
    expect(over.statusCode).toBe(429);
    expect((over.json() as RpcError).error?.code).toBe(-32000);
  });

  it('jawny bodyLimit /mcp/*: ciało ponad 512 KB odrzucone (413) przed parsowaniem', async () => {
    const huge = toolsCallBody('kb_list', { pad: 'x'.repeat(600_000) });
    const res = await mcpRequest(h.bundle.app, 'default', raw, huge);
    expect(res.statusCode).toBe(413);
    // legalne maksimum kb_submit_draft (100 000 znaków treści) nadal przechodzi
    const legal = toolsCallBody('kb_list', { pad: 'x'.repeat(100_000) });
    const ok = await mcpRequest(h.bundle.app, 'default', raw, legal);
    expect(ok.statusCode).toBe(200);
  });

  it('era 2026-07-28 NADAL odrzuca batch (routing er nietknięty)', async () => {
    const res = await mcpModernRequest(h.bundle.app, 'default', raw, 'tools/list');
    expect(res.statusCode).toBe(200); // ścieżka modern żyje

    // tablica z kopertą _meta trafia do handlera v2, który batch odrzuca
    const modernBatch = await h.bundle.app.inject({
      method: 'POST',
      url: '/mcp/default',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-method': 'tools/list',
        authorization: `Bearer ${raw}`,
      },
      payload: [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'vitest', version: '0.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        },
      ],
    });
    expect(modernBatch.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('limity narzędziowe: koszt LLM/OpenSPG poza limitem globalnym', () => {
  let h: TestHarness;
  let raw: string;

  beforeEach(() => {
    h = makeHarness({ tools: [stubTool('kb_search'), stubTool('kb_claim_verify')] });
    createProfile(h.db, {
      id: 'costly',
      name: 'Costly',
      tools: ['kb_search', 'kb_claim_verify'],
    });
    const userId = makeUser(h.db, 'usr_cost');
    raw = createKey(h.db, userId, 'k-cost', ['read'], 'costly', 30).raw;
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('kb_claim_verify: 10/min (11. → -32000), mimo wolnego limitu globalnego', async () => {
    for (let i = 0; i < 10; i++) {
      const ok = await mcpRequest(h.bundle.app, 'costly', raw, toolsCallBody('kb_claim_verify'));
      expect((ok.json() as RpcError).result).toBeDefined();
    }
    const over = await mcpRequest(h.bundle.app, 'costly', raw, toolsCallBody('kb_claim_verify'));
    expect(over.statusCode).toBe(200); // błąd na poziomie JSON-RPC, nie HTTP
    expect((over.json() as RpcError).error?.code).toBe(-32000);
  });

  it('kb_search hybrid/vector: 30/min; tryb text NIE podlega limitowi wektorowemu', async () => {
    for (let i = 0; i < 30; i++) {
      const ok = await mcpRequest(h.bundle.app, 'costly', raw, toolsCallBody('kb_search'));
      expect((ok.json() as RpcError).result).toBeDefined();
    }
    const over = await mcpRequest(h.bundle.app, 'costly', raw, toolsCallBody('kb_search'));
    expect((over.json() as RpcError).error?.code).toBe(-32000);

    // tryb tekstowy (bez embeddingu) przechodzi dalej — limit dotyczy trybu wektorowego
    const text = await mcpRequest(
      h.bundle.app,
      'costly',
      raw,
      toolsCallBody('kb_search', { mode: 'text' }),
    );
    expect((text.json() as RpcError).result).toBeDefined();
  });

  it('batch omijał też limit narzędziowy: 11× kb_claim_verify w jednym POST → 429', async () => {
    const res = await mcpRequest(h.bundle.app, 'costly', raw, batch(11, 'kb_claim_verify'));
    expect(res.statusCode).toBe(200); // 11 < 60, limiter globalny przepuszcza
    const body = res.json() as RpcError[];
    const limited = body.filter((m) => m.error?.code === -32000);
    expect(limited).toHaveLength(1); // 11. wywołanie odbite przez limit narzędziowy
  });
});
