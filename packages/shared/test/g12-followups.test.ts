import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANSWER_TEXT_MAX,
  createKb,
  extractModelName,
  getSettingModelName,
  maskForApi,
  recordAnswer,
  replaceForDocument,
  setProvisioned,
  setSetting,
  type Db,
} from '../src/db/index.js';
import { getBreakerStates, withBreaker } from '../src/llm/index.js';
import { answerQuestion, clearAnswerCache, hybridSearch } from '../src/answer/index.js';
import type { AnswerCtx, AnswerLlm } from '../src/answer/index.js';
import { OpenSpgClient } from '../src/openspg/client.js';
import { jsonResponse, loginResponse, makeMockFetch } from './helpers/openspg-mock.js';
import { testDb } from './helpers.js';

/**
 * G12 — domknięcie ustaleń oznaczonych wcześniej jako CZĘŚCIOWE:
 *  D8-08  treść odpowiedzi nie była nigdzie utrwalana (sędzia LLM mierzył próbkę
 *         obciążoną: tylko odpowiedzi o niskiej pewności miały answer_preview),
 *  D8-11  trafienie cache nie dało się odróżnić od świeżej odpowiedzi,
 *  GAP-05 answers.model NULL w 100 % wierszy (sealed 'llm.chat') + koszt LLM
 *         mierzony tylko dla czatu,
 *  D8-03/D8-10 degradedReasons nie wychodziło poza bibliotekę,
 *  D8-10  breaker brał lock pisarza SQLite przy KAŻDYM wywołaniu w stanie closed,
 *  D8-10  timeout kanału nie anulował realnego żądania OpenSPG.
 */

const NS = 'StagingSmoke';

function seedCorpus(db: Db): void {
  createKb(db, { namespace: NS, name: 'Staging', embeddingModel: 'text-embedding-3-small' });
  db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run(NS);
  setProvisioned(db, NS, 7, 'inst1@text-embedding-3-small', 'hash');
  replaceForDocument(db, NS, 'DOC_EF8A5D4D', [
    {
      id: 'CHUNK_EF8A5D4D_000',
      title: 'Oprawa HighBay LED 150W — karta produktu',
      content:
        'Oprawa przemysłowa HighBay LED 150W przeznaczona do magazynów wysokiego składowania. ' +
        'Strumień świetlny: 21000 lm, skuteczność 140 lm/W. Stopień ochrony IP65.',
    },
  ]);
}

function fakeOpenspg(vectorScore: number): OpenSpgClient {
  const { impl } = makeMockFetch((path) => {
    if (path === '/v1/accounts/login') return loginResponse();
    if (path === '/public/v1/search/vector') {
      return jsonResponse([{ docId: 'CHUNK_EF8A5D4D_000', score: vectorScore, fields: {} }]);
    }
    return jsonResponse([]);
  });
  return new OpenSpgClient({ baseUrl: 'http://openspg:8887', account: 'openspg', password: 'x', fetchImpl: impl });
}

/** LLM stub: chat deklaruje model w wyniku (jak realny ChatResult), embed liczy cosinus. */
function stubLlm(chatModel: string | undefined, cosine = 0.95): AnswerLlm {
  return {
    async chat() {
      return {
        text: 'Strumień świetlny to 21000 lm [1].\nCONFIDENCE: 0.9',
        ...(chatModel !== undefined ? { model: chatModel } : {}),
      };
    },
    async embed(texts: string[]) {
      const sin = Math.sqrt(Math.max(0, 1 - cosine * cosine));
      return texts.map((_t, i) => (i === 0 ? [1, 0] : [cosine, sin]));
    },
  };
}

function makeCtx(db: Db, llm: AnswerLlm | null, openspg: OpenSpgClient | null): AnswerCtx {
  return { db, llm, openspg, log: { warn: () => undefined } };
}

const QUESTION = 'Jaki jest strumień świetlny oprawy HighBay LED 150W?';

// ── D8-08 / D8-11: repozytorium answers ─────────────────────────────────────

describe('recordAnswer: treść odpowiedzi i znacznik cache (D8-08, D8-11)', () => {
  it('utrwala treść i domyślnie oznacza wiersz jako NIE-cache', () => {
    const db = testDb();
    const row = recordAnswer(db, {
      question: 'pytanie',
      source: 'panel',
      answerText: 'Treść odpowiedzi z cytowaniem [1].',
    });
    expect(row.answer_text).toBe('Treść odpowiedzi z cytowaniem [1].');
    expect(row.from_cache).toBe(0);
  });

  it('przycina treść do ANSWER_TEXT_MAX (baza gorącej ścieżki nie rośnie bez granic)', () => {
    const db = testDb();
    const row = recordAnswer(db, {
      question: 'pytanie',
      source: 'mcp',
      answerText: 'x'.repeat(ANSWER_TEXT_MAX + 500),
    });
    expect(row.answer_text).toHaveLength(ANSWER_TEXT_MAX + 1); // + znak wielokropka
    expect(row.answer_text?.endsWith('…')).toBe(true);
  });

  it('pusta treść zapisuje NULL, from_cache=1 dla trafienia cache', () => {
    const db = testDb();
    expect(recordAnswer(db, { question: 'q', source: 'mcp', answerText: '   ' }).answer_text).toBeNull();
    expect(recordAnswer(db, { question: 'q', source: 'mcp', fromCache: true }).from_cache).toBe(1);
  });

  it('RODO: anonimizacja pytania kasuje też treść odpowiedzi (wyzwalacz z migracji 0060)', () => {
    const db = testDb();
    const row = recordAnswer(db, {
      question: 'pytanie z danymi osobowymi',
      source: 'panel',
      userId: null,
      answerText: 'odpowiedź pochodna pytania',
    });
    // Dokładnie ten UPDATE, który robi apps/panel-api/src/services/retention.ts.
    db.prepare("UPDATE answers SET question = ?, user_id = NULL, api_key_id = NULL WHERE id = ?").run(
      '[usunięte]',
      row.id,
    );
    const after = db.prepare('SELECT question, answer_text FROM answers WHERE id = ?').get(row.id) as {
      question: string;
      answer_text: string | null;
    };
    expect(after.question).toBe('[usunięte]');
    expect(after.answer_text).toBeNull();
  });

  it('zwykła aktualizacja bez odcięcia atrybucji NIE kasuje treści', () => {
    const db = testDb();
    const row = recordAnswer(db, {
      question: 'pytanie',
      source: 'panel',
      userId: 'user_1',
      answerText: 'treść',
    });
    db.prepare('UPDATE answers SET question = ? WHERE id = ?').run('inne pytanie', row.id);
    const after = db.prepare('SELECT answer_text FROM answers WHERE id = ?').get(row.id) as {
      answer_text: string | null;
    };
    expect(after.answer_text).toBe('treść');
  });
});

// ── GAP-05: nazwa modelu jako wartość NIESEKRETNA ───────────────────────────

describe('settings: nazwa modelu poza pieczęcią (GAP-05)', () => {
  const seal = (plain: string): string => Buffer.from(plain, 'utf8').toString('base64');
  const unseal = (sealed: string): string => Buffer.from(sealed, 'base64').toString('utf8');

  it('extractModelName wyciąga model tylko z obiektu z niepustym stringiem', () => {
    expect(extractModelName({ model: ' gpt-4o-mini ' })).toBe('gpt-4o-mini');
    expect(extractModelName({ model: '' })).toBeNull();
    expect(extractModelName({ apiKey: 'sk-x' })).toBeNull(); // gitleaks:allow
    expect(extractModelName('gpt-4o')).toBeNull();
    expect(extractModelName(null)).toBeNull();
  });

  it('sekret zostaje zapieczętowany, ale model jest czytelny BEZ unseal', () => {
    const db = testDb();
    setSetting(
      db,
      'llm.chat',
      { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-live-abcdef123456', model: 'gpt-4o-mini' }, // gitleaks:allow
      { isSecret: true, seal, updatedBy: 'admin_1' },
    );
    const stored = db.prepare("SELECT value_json, is_secret FROM settings WHERE key = 'llm.chat'").get() as {
      value_json: string;
      is_secret: number;
    };
    // klucz API NADAL zapieczętowany — to jest twarda zasada, której nie wolno złamać
    expect(stored.is_secret).toBe(1);
    expect(stored.value_json).not.toContain('sk-live');

    expect(getSettingModelName(db, 'llm.chat')).toBe('gpt-4o-mini');
    const masked = maskForApi(db, 'llm.chat');
    expect(masked.modelName).toBe('gpt-4o-mini');
    expect(masked).not.toHaveProperty('value');
    expect(JSON.stringify(masked)).not.toContain('sk-live');
    // z unseal nadal tylko podgląd klucza, nigdy pełna wartość
    expect(maskForApi(db, 'llm.chat', { unseal }).preview).toBe('sk***56');
  });

  it('ustawienie bez modelu nie ustawia model_name', () => {
    const db = testDb();
    setSetting(db, 'learning.threshold', 0.45);
    expect(getSettingModelName(db, 'learning.threshold')).toBeNull();
  });
});

// ── D8-10: breaker nie rywalizuje o lock w stanie spoczynku ─────────────────

describe('withBreaker: brak zbędnych zapisów w stanie closed (D8-10)', () => {
  /** Licznik realnych zapisów do tabeli breakers (WAL rośnie tylko przy zapisie). */
  function countWrites(db: Db): { writes: number; restore: () => void } {
    const counter = { writes: 0 };
    const original = db.prepare.bind(db);
    const patched = ((sql: string) => {
      if (/^\s*(INSERT|UPDATE)\b/i.test(sql) && /breakers/i.test(sql)) {
        const stmt = original(sql);
        const run = stmt.run.bind(stmt);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (stmt as any).run = (...args: unknown[]) => {
          counter.writes += 1;
          return run(...(args as never[]));
        };
        return stmt;
      }
      return original(sql);
    }) as typeof db.prepare;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).prepare = patched;
    return {
      get writes() {
        return counter.writes;
      },
      restore: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).prepare = original;
      },
    } as { writes: number; restore: () => void };
  }

  it('zdrowy breaker: pierwsze wywołanie zakłada wiersz, kolejne NIE piszą nic', async () => {
    const db = testDb();
    const probe = countWrites(db);
    await withBreaker(db, 'openspg', () => Promise.resolve('ok'));
    const afterFirst = probe.writes;
    expect(afterFirst).toBe(1); // sam INSERT wiersza

    for (let i = 0; i < 5; i++) await withBreaker(db, 'openspg', () => Promise.resolve('ok'));
    expect(probe.writes).toBe(afterFirst); // ZERO dodatkowych zapisów
    probe.restore();
    expect(getBreakerStates(db).find((b) => b.name === 'openspg')?.state).toBe('closed');
  });

  it('sukces po porażce nadal zeruje licznik (zapis, bo stan się zmienia)', async () => {
    const db = testDb();
    await expect(withBreaker(db, 'llm.chat', () => Promise.reject(new Error('padło')))).rejects.toThrow();
    expect(getBreakerStates(db).find((b) => b.name === 'llm.chat')?.failureCount).toBe(1);
    await withBreaker(db, 'llm.chat', () => Promise.resolve('ok'));
    const s = getBreakerStates(db).find((b) => b.name === 'llm.chat');
    expect(s?.failureCount).toBe(0);
    expect(s?.reason).toBeNull();
  });
});

// ── D8-10: AbortSignal w kliencie OpenSPG ───────────────────────────────────

describe('OpenSpgClient: AbortSignal (D8-10)', () => {
  it('withSignal anuluje żądanie w locie i dzieli sesję z oryginałem', async () => {
    let seenSignal: AbortSignal | null = null;
    const { impl, calls } = makeMockFetch(async (path, init) => {
      if (path === '/v1/accounts/login') return loginResponse();
      seenSignal = (init?.signal ?? null) as AbortSignal | null;
      // żądanie, które nigdy samo nie odpowie — kończy je wyłącznie abort
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = new OpenSpgClient({
      baseUrl: 'http://openspg:8887',
      account: 'openspg',
      password: 'x',
      fetchImpl: impl,
      timeoutMs: 60_000, // własny timeout klienta DALEKO poza deadline'em wołającego
    });
    const controller = new AbortController();
    const scoped = client.withSignal(controller.signal);
    const pending = scoped.request('/public/v1/search/text', { method: 'POST' });
    // deadline wołającego (odpowiednik 5 s kanału retrievalu)
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow(/anulowane przez wołającego/);
    expect(seenSignal).not.toBeNull();
    // sesja współdzielona: wariant zalogował się raz, oryginał nie loguje ponownie
    expect(calls.filter((c) => c.path === '/v1/accounts/login')).toHaveLength(1);
  });

  it('deadline kanału retrievalu ANULUJE żądanie OpenSPG (nie tylko przestaje czekać)', async () => {
    vi.useFakeTimers();
    try {
      const db = testDb();
      seedCorpus(db);
      let aborted = false;
      const { impl } = makeMockFetch(async (path, init) => {
        if (path === '/v1/accounts/login') return loginResponse();
        // Serwer, który nigdy nie odpowiada — jedynym wyjściem jest abort.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });
      const openspg = new OpenSpgClient({
        baseUrl: 'http://openspg:8887',
        account: 'openspg',
        password: 'x',
        fetchImpl: impl,
        timeoutMs: 30_000, // domyślny timeout klienta — 6× dłuższy niż deadline kanału
      });
      const pending = hybridSearch(makeCtx(db, null, openspg), {
        query: 'strumień świetlny oprawy HighBay',
        allowedNamespaces: [NS],
      });
      await vi.advanceTimersByTimeAsync(5_000); // CHANNEL_TIMEOUT_MS
      const res = await pending;
      expect(aborted).toBe(true); // dotąd żądanie żyło jeszcze 25 s
      expect(res.degradedReasons).toContain('openspg_down');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bez sygnału zachowanie bez zmian (własny timeout klienta → "timeout")', async () => {
    const { impl } = makeMockFetch(async (path, init) => {
      if (path === '/v1/accounts/login') return loginResponse();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = new OpenSpgClient({
      baseUrl: 'http://openspg:8887',
      account: 'openspg',
      password: 'x',
      fetchImpl: impl,
      timeoutMs: 5,
    });
    await expect(client.request('/public/v1/search/text', { method: 'POST' })).rejects.toThrow(/timeout/);
  });
});

// ── D8-08 / D8-11 / GAP-05 / D8-03: pipeline answerQuestion ────────────────

describe('answerQuestion: treść, cache, model i powody degradacji', () => {
  beforeEach(() => clearAnswerCache());

  it('zapisuje treść odpowiedzi, model z ChatResult i degradedReasons', async () => {
    const db = testDb();
    seedCorpus(db);
    const res = await answerQuestion(makeCtx(db, stubLlm('gpt-4o-mini-2026'), fakeOpenspg(0.9)), {
      question: QUESTION,
      allowedNamespaces: [NS],
      source: 'mcp',
    });
    expect(res.noAnswer).toBe(false);
    // GAP-05: model z WYNIKU wywołania, nie z (zapieczętowanej) konfiguracji
    expect(res.model).toBe('gpt-4o-mini-2026');
    expect(Array.isArray(res.degradedReasons)).toBe(true);

    const row = db.prepare('SELECT * FROM answers WHERE id = ?').get(res.answerId) as {
      model: string | null;
      answer_text: string | null;
      from_cache: number;
    };
    expect(row.model).toBe('gpt-4o-mini-2026');
    expect(row.answer_text).toBe(res.answer); // D8-08: treść utrwalona
    expect(row.from_cache).toBe(0);
  });

  it('trafienie cache dostaje własny wiersz z from_cache=1 i tą samą treścią (D8-11)', async () => {
    const db = testDb();
    seedCorpus(db);
    const ctx = makeCtx(db, stubLlm('gpt-4o-mini-2026'), fakeOpenspg(0.9));
    const first = await answerQuestion(ctx, { question: QUESTION, allowedNamespaces: [NS], source: 'mcp' });
    const second = await answerQuestion(ctx, { question: QUESTION, allowedNamespaces: [NS], source: 'mcp' });
    expect(second.answerId).not.toBe(first.answerId);

    const rows = db
      .prepare('SELECT id, from_cache, answer_text FROM answers ORDER BY created_at, id')
      .all() as { id: string; from_cache: number; answer_text: string | null }[];
    expect(rows).toHaveLength(2);
    const cachedRow = rows.find((r) => r.id === second.answerId)!;
    expect(cachedRow.from_cache).toBe(1);
    expect(cachedRow.answer_text).toBe(first.answer);
  });

  it('odmowa: powody degradacji dostępne, treść NULL (no_answer niesie sam fakt)', async () => {
    const db = testDb();
    seedCorpus(db);
    // Brak OpenSPG → retrieval zdegradowany; pytanie spoza bazy → odmowa przed chatem.
    const res = await answerQuestion(makeCtx(db, stubLlm('m', 0.2), null), {
      question: 'przepis na bigos staropolski',
      allowedNamespaces: [NS],
      source: 'mcp',
    });
    expect(res.noAnswer).toBe(true);
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toContain('openspg_down');
    const row = db.prepare('SELECT answer_text FROM answers WHERE id = ?').get(res.answerId) as {
      answer_text: string | null;
    };
    expect(row.answer_text).toBeNull();
  });
});
