import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getSetting } from '@pomagierkb/shared/db';
import { unseal } from '@pomagierkb/shared/crypto';
import { AppError } from '@pomagierkb/shared/errors';
import { makeTestConfig } from '../src/config.js';
import { testLlm } from '../src/services/settings.js';
import { makeTestApp, as, type TestCtx } from './admin-helpers.js';

/**
 * Ustawienia: maskowanie sekretów w GET, zapis sekretu (seal AES-GCM przez
 * TOKEN_ENC_KEY — weryfikacja przez unseal w teście), pusty apiKey = bez zmiany,
 * RBAC (tylko admin) i test-llm z wstrzykniętym klientem.
 */

const config = makeTestConfig();
const keyB64 = config.tokenEncKey.toString('base64');

describe('settings', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    ctx.db.close();
  });

  it('GET /settings wymaga admina (operator → 403, brak sesji → 401)', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(anon.statusCode).toBe(401);
    const op = await ctx.app.inject({ method: 'GET', url: '/api/v1/settings', headers: as('operator') });
    expect(op.statusCode).toBe(403);
  });

  it('GET /settings zwraca WSZYSTKIE klucze białej listy (nieskonfigurowane → configured:false)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/settings', headers: as('admin') });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    for (const key of ['llm.chat', 'llm.openie', 'llm.embeddings', 'learning.threshold', 'chunking', 'ingest.limits']) {
      expect(data[key]).toBeDefined();
    }
    expect(data['llm.chat'].configured).toBe(false);
  });

  it('PUT sekretu: w DB tylko sealed (odczyt przez unseal), w GET tylko preview', async () => {
    const value = { baseUrl: 'https://llm.test/v1', apiKey: 'sk-super-tajny-klucz-123', model: 'gpt-test' };
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/llm.chat',
      headers: as('admin'),
      payload: { value },
    });
    expect(put.statusCode).toBe(200);
    // Odpowiedź NIGDY nie zawiera pełnego sekretu.
    expect(JSON.stringify(put.json())).not.toContain('sk-super-tajny-klucz-123');
    expect(put.json().data.preview).toMatch(/^sk\*\*\*/);

    // W DB: {"sealed": ...} — plaintext NIE występuje w value_json.
    const row = ctx.db.prepare("SELECT value_json, is_secret FROM settings WHERE key = 'llm.chat'").get() as {
      value_json: string;
      is_secret: number;
    };
    expect(row.is_secret).toBe(1);
    expect(row.value_json).not.toContain('sk-super-tajny-klucz-123');
    const sealed = (JSON.parse(row.value_json) as { sealed: string }).sealed;
    expect(JSON.parse(unseal(sealed, keyB64))).toEqual(value);

    // Odczyt konfiguracji przez repo z unseal (droga używana przez serwisy).
    const setting = getSetting(ctx.db, 'llm.chat', { unseal: (s) => unseal(s, keyB64) });
    expect(setting?.value).toEqual(value);

    // GET po zapisie: configured + preview, bez value.
    const get = await ctx.app.inject({ method: 'GET', url: '/api/v1/settings', headers: as('admin') });
    const masked = get.json().data['llm.chat'];
    expect(masked.configured).toBe(true);
    expect(masked.value).toBeUndefined();
    expect(JSON.stringify(get.json())).not.toContain('sk-super-tajny-klucz-123');
  });

  it('PUT sekretu z pustym apiKey = bez zmiany klucza (aktualizacja baseUrl/model)', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/llm.chat',
      headers: as('admin'),
      payload: { value: { baseUrl: 'https://llm2.test/v1', apiKey: '', model: 'gpt-test-2' } },
    });
    expect(put.statusCode).toBe(200);
    const setting = getSetting(ctx.db, 'llm.chat', { unseal: (s) => unseal(s, keyB64) });
    expect(setting?.value).toEqual({
      baseUrl: 'https://llm2.test/v1',
      apiKey: 'sk-super-tajny-klucz-123', // zachowany poprzedni
      model: 'gpt-test-2',
    });
  });

  it('PUT ustawienia jawnego zapisuje plaintext i GET zwraca value', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/learning.threshold',
      headers: as('admin'),
      payload: { value: 0.42 },
    });
    expect(put.statusCode).toBe(200);
    const get = await ctx.app.inject({ method: 'GET', url: '/api/v1/settings', headers: as('admin') });
    expect(get.json().data['learning.threshold']).toMatchObject({ configured: true, value: 0.42 });
  });

  it('PUT klucza spoza białej listy → 400 validation_error', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/nie.ma.takiego',
      headers: as('admin'),
      payload: { value: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('zapis sekretu jest audytowany BEZ wartości sekretu', async () => {
    const rows = ctx.db
      .prepare("SELECT after_json, metadata_json FROM audit WHERE action = 'settings.update'")
      .all() as { after_json: string | null; metadata_json: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.after_json ?? '').not.toContain('sk-super-tajny-klucz-123');
      expect(r.metadata_json ?? '').not.toContain('sk-super-tajny-klucz-123');
    }
  });
});

describe('testLlm (serwis, wstrzyknięty klient)', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await makeTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    ctx.db.close();
  });

  it('brak konfiguracji → 503 not_ready', async () => {
    await expect(testLlm(ctx.db, ctx.app.config, 'chat')).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('sukces zwraca {ok, model, latencyMs}; embeddings woła embed', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/llm.embeddings',
      headers: as('admin'),
      payload: { value: { baseUrl: 'https://llm.test/v1', apiKey: 'sk-emb', model: 'embed-1' } },
    });
    expect(put.statusCode).toBe(200);

    let chatCalls = 0;
    let embedCalls = 0;
    const result = await testLlm(ctx.db, ctx.app.config, 'embeddings', {
      makeClient: () => ({
        chat: async () => {
          chatCalls += 1;
          return { text: 'pong' };
        },
        embed: async () => {
          embedCalls += 1;
          return [[0.1, 0.2]];
        },
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe('embed-1');
    expect(typeof result.latencyMs).toBe('number');
    expect(embedCalls).toBe(1);
    expect(chatCalls).toBe(0);
  });

  it('błąd upstreamu propaguje AppError (→ 502 w kopercie)', async () => {
    await expect(
      testLlm(ctx.db, ctx.app.config, 'embeddings', {
        makeClient: () => ({
          chat: async () => ({ text: '' }),
          embed: async () => {
            throw new AppError('upstream_error', 'LLM padł', { service: 'llm' });
          },
        }),
      }),
    ).rejects.toMatchObject({ code: 'upstream_error', statusCode: 502 });
  });
});
