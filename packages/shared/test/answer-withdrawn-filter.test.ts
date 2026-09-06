import { describe, expect, it } from 'vitest';
import { hybridSearch } from '../src/answer/index.js';
import type { AnswerCtx } from '../src/answer/index.js';
import { createKb, replaceForDocument, setProvisioned, type Db } from '../src/db/index.js';
import { OpenSpgClient } from '../src/openspg/client.js';
import { jsonResponse, loginResponse, makeMockFetch } from './helpers/openspg-mock.js';
import { testDb } from './helpers.js';

/**
 * Wycofana treść nie może wracać z kanałów OpenSPG (D7-02 / D14-01).
 *
 * Kontekst — obserwacja z PRODUKCJI przy przebudowie StagingSmoke 2026-09-06: builder
 * przyjął wiersze-nagrobki (`semanticType=tombstone`, `content=__WITHDRAWN__`), job
 * zakończył się sukcesem, rejestr oznaczył nagrobki jako potwierdzone — a węzły w grafie
 * ZACHOWAŁY pełną, starą treść i `semanticType="chunk"`. `search/text` zwracał je z tym
 * samym score co wersje żywe:
 *
 *   score=0.51 | CHUNK_2CE534D09DDB7838_001 | "## Sterowanie Wersja DALI-2 pozwala n
 *   score=0.51 | CHUNK_EF8A5D4D_001         | "## Sterowanie\nWersja DALI-2 pozwala
 *
 * UPSERT zamrożonego upstreamu nie kasuje treści, więc egzekwowanie wycofania musi żyć
 * w retrievalu. Filtr idzie po `graph_ids.live`, a NIE po `chunks_mirror`: kanał tekstowy
 * pyta też o `Ns.ReferenceDocument`, a dokumentów w mirrorze nie ma.
 */

const NS = 'StagingSmoke';

function seed(db: Db): void {
  createKb(db, { namespace: NS, name: 'Staging', embeddingModel: 'text-embedding-3-small' });
  db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run(NS);
  setProvisioned(db, NS, 1, 'inst@text-embedding-3-small', 'h');
  replaceForDocument(db, NS, 'DOC_NOWY', [
    {
      id: 'CHUNK_NOWY_000',
      title: 'Sterowanie',
      content: 'Wersja DALI-2 pozwala na ściemnianie i integrację z systemem budynku.',
    },
  ]);
  const ins = db.prepare(
    `INSERT INTO graph_ids (namespace, id, entity, live, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  ins.run(NS, 'CHUNK_NOWY_000', 'Chunk', 1);
  ins.run(NS, 'CHUNK_STARY_000', 'Chunk', 0); // wycofany — nagrobek wystawiony i „potwierdzony"
  ins.run(NS, 'DOC_NOWY', 'ReferenceDocument', 1);
  ins.run(NS, 'DOC_STARY', 'ReferenceDocument', 0);
}

function ctxOf(db: Db, openspg: OpenSpgClient): AnswerCtx {
  return { db, llm: null, openspg, log: { warn: () => undefined } };
}

/** Kanał tekstowy oddający to, co realnie zwraca produkcja: żywe I wycofane węzły. */
function openspgReturning(ids: string[]): OpenSpgClient {
  const { impl } = makeMockFetch((path) => {
    if (path === '/v1/accounts/login') return loginResponse();
    if (path === '/public/v1/search/text') {
      return jsonResponse(
        ids.map((id, i) => ({
          docId: id,
          score: 1.5 - i * 0.01,
          fields: {
            id,
            content: id.includes('STARY') ? 'TRESC WYCOFANA — nie moze wyjsc' : 'Sterowanie DALI-2',
          },
        })),
      );
    }
    return jsonResponse([]);
  });
  return new OpenSpgClient({ baseUrl: 'http://openspg:8887', account: 'o', password: 'x', fetchImpl: impl });
}

describe('retrieval odsiewa id wycofane ze stanu docelowego (D7-02/D14-01)', () => {
  it('nie zwraca chunka oznaczonego jako wycofany', async () => {
    const db = testDb();
    seed(db);
    const res = await hybridSearch(ctxOf(db, openspgReturning(['CHUNK_NOWY_000', 'CHUNK_STARY_000'])), {
      query: 'sterowanie DALI ściemnianie',
      allowedNamespaces: [NS],
    });
    const ids = res.results.map((h) => h.id);
    expect(ids).toContain('CHUNK_NOWY_000');
    expect(ids).not.toContain('CHUNK_STARY_000');
    expect(JSON.stringify(res.results)).not.toContain('TRESC WYCOFANA');
  });

  it('nie zwraca wycofanego DOKUMENTU, choć dokumentów nie ma w mirrorze', async () => {
    const db = testDb();
    seed(db);
    const res = await hybridSearch(ctxOf(db, openspgReturning(['DOC_NOWY', 'DOC_STARY'])), {
      query: 'sterowanie DALI ściemnianie',
      allowedNamespaces: [NS],
    });
    const ids = res.results.map((h) => h.id);
    expect(ids).not.toContain('DOC_STARY');
  });

  it('id nieznane rejestrowi przechodzi (bazy sprzed rejestru graph_ids)', async () => {
    const db = testDb();
    seed(db);
    const res = await hybridSearch(ctxOf(db, openspgReturning(['CHUNK_LEGACY_999'])), {
      query: 'sterowanie DALI ściemnianie',
      allowedNamespaces: [NS],
    });
    expect(res.results.map((h) => h.id)).toContain('CHUNK_LEGACY_999');
  });
});
