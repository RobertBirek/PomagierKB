import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@pomagierkb/shared/errors';
import { createKey } from '@pomagierkb/shared/db';
import { newErrorId, toolErrorMessage, toolErrorText } from '../src/tools/messages.js';
import { appErrorToResult } from '../src/tools/common.js';
import { makeHarness, makeUser, mcpRequest, toolsCallBody, type TestHarness } from './helpers.js';
import type { KbTool, ToolCtx } from '../src/tools/types.js';

/**
 * D9-05: komunikaty upstreamu (OpenSPG, LLM, dowolny wyjątek) NIE mogą wyciekać
 * do klienta MCP — mogą nieść nazwę hosta wewnętrznego, fragment odpowiedzi serwera
 * Javy albo komunikat dostawcy LLM. Klient dostaje słownik PL + identyfikator zdarzenia;
 * szczegóły trafiają wyłącznie do logu pino.
 */

/** Sekret-marker, który MUSI zniknąć z odpowiedzi (imituje wyciek nazwy hosta). */
const LEAK = 'release-openspg-server:8887 (neo4j://kag-neo4j)';

function throwingTool(err: unknown): KbTool {
  return {
    name: 'kb_list',
    title: 'Stub rzucający',
    description: 'Stub, który rzuca wyjątkiem upstreamu.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: { type: 'object', properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async () => {
      throw err;
    },
  };
}

describe('słownik komunikatów błędów narzędzi (czysta logika)', () => {
  it('toolErrorText: nazwa narzędzia + tekst ze słownika + identyfikator', () => {
    const id = newErrorId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const text = toolErrorText('kb_search', 'upstream_unavailable', id);
    expect(text).toContain('kb_search');
    expect(text).toContain(toolErrorMessage('upstream_unavailable'));
    expect(text).toContain(id);
  });

  it('appErrorToResult: błąd upstreamu → komunikat ze słownika, BEZ treści z upstreamu', () => {
    const out = appErrorToResult(new AppError('upstream_error', `OpenSPG HTTP 500: ${LEAK}`));
    expect(out?.isError).toBe(true);
    expect((out?.structured as { errorCode: string }).errorCode).toBe('upstream_unavailable');
    expect(out?.text).not.toContain(LEAK);
    expect(out?.text).not.toContain('OpenSPG');
    expect(out?.text).toMatch(/id błędu: [0-9a-f]{8}/);
  });

  it('appErrorToResult: rate_limited też bez treści wewnętrznej; nie-AppError → null', () => {
    const rl = appErrorToResult(new AppError('rate_limited', 'bucket llm.chat wyczerpany'));
    expect(rl?.text).toBe(toolErrorMessage('rate_limited'));
    expect(rl?.text).not.toContain('llm.chat');
    expect(appErrorToResult(new TypeError('boom'))).toBeNull();
  });

  it('appErrorToResult loguje szczegóły pod tym samym identyfikatorem', () => {
    const logged: Record<string, unknown>[] = [];
    const log = {
      error: (obj: Record<string, unknown>) => logged.push(obj),
    } as unknown as ToolCtx['log'];
    const out = appErrorToResult(new AppError('upstream_timeout', LEAK), log);
    const errorId = /id błędu: ([0-9a-f]{8})/.exec(out?.text ?? '')?.[1];
    expect(errorId).toBeDefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ errorId, err: LEAK });
  });
});

describe('shell MCP: wyjątek narzędzia nie przenosi treści upstreamu do klienta', () => {
  let h: TestHarness;
  let raw: string;

  function setup(err: unknown): void {
    h = makeHarness({ tools: [throwingTool(err)] });
    const userId = makeUser(h.db, 'usr_leak');
    raw = createKey(h.db, userId, 'k-leak', ['read'], 'default', 30).raw;
  }

  afterEach(async () => {
    await h.cleanup();
  });

  it('wyjątek z nazwą hosta → isError + errorCode + errorId, bez wycieku', async () => {
    setup(new AppError('upstream_error', `OpenSPG HTTP 500: ${LEAK}`));
    const res = await mcpRequest(h.bundle.app, 'default', raw, toolsCallBody('kb_list'));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('release-openspg-server');
    expect(res.body).not.toContain('neo4j');
    const body = res.json() as {
      result: {
        isError: boolean;
        structuredContent: { errorCode: string; errorId: string };
        content: { text: string }[];
      };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.errorCode).toBe('upstream_unavailable');
    expect(body.result.structuredContent.errorId).toMatch(/^[0-9a-f]{8}$/);
    expect(body.result.content[0]!.text).toContain(body.result.structuredContent.errorId);
  });

  it('zwykły TypeError → errorCode internal, treść wyjątku nie opuszcza serwera', async () => {
    setup(new TypeError(`Cannot read properties of undefined (reading '${LEAK}')`));
    const res = await mcpRequest(h.bundle.app, 'default', raw, toolsCallBody('kb_list'));
    expect(res.body).not.toContain('Cannot read properties');
    expect(res.body).not.toContain('release-openspg-server');
    const body = res.json() as { result: { structuredContent: { errorCode: string } } };
    expect(body.result.structuredContent.errorCode).toBe('internal');
  });

  it('REGRESJA: błąd walidacji wejścia nadal niesie konkret (to nasz komunikat, nie upstream)', async () => {
    setup(new Error('nieużywane'));
    const res = await mcpRequest(
      h.bundle.app,
      'default',
      raw,
      toolsCallBody('kb_list', { nieznanePole: 1 }),
    );
    const body = res.json() as {
      result: { isError: boolean; structuredContent: { errorCode: string; problems: string[] } };
    };
    expect(body.result.structuredContent.errorCode).toBe('validation');
    expect(body.result.structuredContent.problems.join(' ')).toContain('nieznanePole');
  });
});
