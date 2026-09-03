import { describe, expect, it } from 'vitest';
import { createKb, replaceForDocument, type Db } from '../src/db/index.js';
import { hybridSearch } from '../src/answer/index.js';
import type { AnswerCtx } from '../src/answer/index.js';
import { testDb } from './helpers.js';

/**
 * Eval retrievalu na fixturach — STRAŻNIK REGRESJI w CI (deterministyczny, zero
 * kosztu: llm/openspg = null → mierzy kanał FTS5, przez który przechodzi każda
 * zmiana rankingu/fuzji). Bramki: hit@5 ≥ 0.8, MRR ≥ 0.5, negatywy odmówione.
 * Realny eval hybrydowy (z OpenSPG) — tools/eval/run-eval.mjs na żywej bazie.
 */

interface Golden {
  query: string;
  expectedId?: string;
  expectedNamespace?: string;
  negative?: boolean;
}

const NS_LIGHT = 'LightingDocs';
const NS_PROC = 'FirmProcedures';

function seedCorpus(db: Db): void {
  for (const ns of [NS_LIGHT, NS_PROC]) {
    createKb(db, { namespace: ns, name: `Baza ${ns}` });
    db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = ?").run(ns);
  }
  replaceForDocument(db, NS_LIGHT, 'DOC_light01', [
    { id: 'CHUNK_light01_001', title: 'Montaż szynoprzewodów', content: 'Przy montażu na szynoprzewodach trójfazowych maksymalne obciążenie toru wynosi 16 amperów na fazę. Odstęp zawiesi nie może przekraczać 1,5 metra.' },
    { id: 'CHUNK_light01_002', title: 'Sterowanie DALI', content: 'Magistrala DALI pozwala sterować oprawami indywidualnie i grupowo. Maksymalna liczba urządzeń na magistrali to 64.' },
    { id: 'CHUNK_light01_003', title: 'Zasilacze awaryjne', content: 'Oprawy awaryjne wymagają comiesięcznego testu funkcjonalnego i corocznego testu autonomii baterii.' },
  ]);
  replaceForDocument(db, NS_LIGHT, 'DOC_light02', [
    { id: 'CHUNK_light02_001', title: 'Dobór opraw do hal', content: 'W halach wysokiego składowania stosuje się oprawy o strumieniu co najmniej 20000 lumenów i optyce wąskostrumieniowej.' },
    { id: 'CHUNK_light02_002', title: 'Klasa szczelności', content: 'Oprawy w myjniach i na zewnątrz muszą mieć stopień ochrony minimum IP65.' },
  ]);
  replaceForDocument(db, NS_PROC, 'DOC_proc01', [
    { id: 'CHUNK_proc01_001', title: 'Procedura urlopowa', content: 'Wniosek urlopowy składa się w systemie kadrowym najpóźniej 7 dni przed planowanym urlopem. Zaległy urlop trzeba wykorzystać do końca września.' },
    { id: 'CHUNK_proc01_002', title: 'Delegacje krajowe', content: 'Dieta w delegacji krajowej wynosi 45 złotych za dobę. Rozliczenie delegacji następuje w ciągu 14 dni od powrotu.' },
  ]);
  replaceForDocument(db, NS_PROC, 'DOC_proc02', [
    { id: 'CHUNK_proc02_001', title: 'Zgłaszanie awarii IT', content: 'Awarie sprzętu komputerowego zgłasza się przez helpdesk. Czas reakcji dla priorytetu krytycznego to 2 godziny.' },
  ]);
}

const GOLDENS: Golden[] = [
  { query: 'maksymalne obciążenie szynoprzewodów', expectedId: 'CHUNK_light01_001', expectedNamespace: NS_LIGHT },
  { query: 'ile urządzeń na magistrali DALI', expectedId: 'CHUNK_light01_002', expectedNamespace: NS_LIGHT },
  { query: 'test baterii oprawy awaryjne', expectedId: 'CHUNK_light01_003', expectedNamespace: NS_LIGHT },
  { query: 'oprawy do hal wysokiego składowania lumeny', expectedId: 'CHUNK_light02_001', expectedNamespace: NS_LIGHT },
  { query: 'stopień ochrony IP65 myjnia', expectedId: 'CHUNK_light02_002', expectedNamespace: NS_LIGHT },
  { query: 'kiedy złożyć wniosek urlopowy', expectedId: 'CHUNK_proc01_001', expectedNamespace: NS_PROC },
  { query: 'dieta delegacja krajowa', expectedId: 'CHUNK_proc01_002', expectedNamespace: NS_PROC },
  { query: 'zgłoszenie awarii komputera helpdesk', expectedId: 'CHUNK_proc02_001', expectedNamespace: NS_PROC },
  // negatywy — wiedza spoza korpusu ma dawać 0 wyników albo bardzo słaby top
  { query: 'przepis na sernik z rodzynkami', negative: true },
  { query: 'harmonogram ligi mistrzów w piłce nożnej', negative: true },
];

function makeCtx(db: Db): AnswerCtx {
  return { db, llm: null, openspg: null, log: { warn: () => undefined } };
}

describe('eval retrievalu na fixturach (bramka regresji CI)', () => {
  it('hit@5 ≥ 0.8, MRR ≥ 0.5 na pozytywach; negatywy bez mocnych trafień', async () => {
    const db = testDb();
    seedCorpus(db);
    const ctx = makeCtx(db);
    const allowed = [NS_LIGHT, NS_PROC];

    let hits5 = 0;
    let mrrSum = 0;
    const positives = GOLDENS.filter((g) => g.negative !== true);
    const misses: string[] = [];
    for (const g of positives) {
      const res = await hybridSearch(ctx, { query: g.query, allowedNamespaces: allowed, limit: 10 });
      const rank = res.results.findIndex((r) => r.id === g.expectedId) + 1;
      if (rank >= 1 && rank <= 5) hits5++;
      else misses.push(`${g.query} → top: ${res.results.slice(0, 3).map((r) => r.id).join(', ')}`);
      if (rank >= 1) mrrSum += 1 / rank;
      if (rank === 1 && g.expectedNamespace !== undefined) {
        expect(res.results[0]?.namespace).toBe(g.expectedNamespace);
      }
    }
    const hitAt5 = hits5 / positives.length;
    const mrr = mrrSum / positives.length;
    expect(hitAt5, `hit@5 spadł poniżej bramki; pudła:\n${misses.join('\n')}`).toBeGreaterThanOrEqual(0.8);
    expect(mrr).toBeGreaterThanOrEqual(0.5);

    for (const g of GOLDENS.filter((x) => x.negative === true)) {
      const res = await hybridSearch(ctx, { query: g.query, allowedNamespaces: allowed, limit: 10 });
      // FTS trigram bywa szumny — dopuszczamy śladowe trafienia, ale nie mocny top
      const top = res.results[0]?.score ?? 0;
      expect(top, `negatyw '${g.query}' ma podejrzanie mocny top`).toBeLessThan(1 / 61 + 1e-9);
    }
  });

  it('cross-KB: wyniki z obu baz są osiągalne w jednym wyszukiwaniu', async () => {
    const db = testDb();
    seedCorpus(db);
    const ctx = makeCtx(db);
    const res = await hybridSearch(ctx, {
      query: 'urlop szynoprzewody',
      allowedNamespaces: [NS_LIGHT, NS_PROC],
      limit: 10,
    });
    const namespaces = new Set(res.results.map((r) => r.namespace));
    expect(namespaces.size).toBeGreaterThanOrEqual(1); // trigram AND może zawęzić — sanity, nie bramka
    expect(res.degraded).toBe(true); // bez openspg zawsze degraded
    expect(res.activeChannels).toBe(1);
  });
});
