#!/usr/bin/env node
// PomagierKB — eval retrievalu na zbiorze goldens (hit@1/hit@5/MRR), zero kosztu LLM.
// Użycie: DATA_DIR=./data node tools/eval/run-eval.mjs [ścieżka/goldens.jsonl]
// Format wiersza goldens.jsonl:
//   {"question":"...", "expectedIds":["CHUNK_..."|"DOC_..."], "namespaces":["Ns"], "negative":false}
//   negative:true = pytanie SPOZA bazy — zalicza się, gdy retrieval NIE zwraca wyniku ≥ minScore.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '@pomagierkb/shared/db';
import { hybridSearch } from '@pomagierkb/shared/answer';

const goldensPath = process.argv[2] ?? process.env.GOLDENS_FILE ?? 'goldens.jsonl';
const dataDir = process.env.DATA_DIR ?? './data';
const dbPath = process.env.EVAL_DB ?? join(dataDir, 'db', 'kag.db');
const minScore = Number(process.env.EVAL_MIN_SCORE ?? '0.01');

if (!existsSync(goldensPath)) {
  console.error(`Brak pliku goldens: ${goldensPath} — utwórz go przy pierwszych ingestach (patrz docs/design/PLAN.md → Eval).`);
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`Brak bazy: ${dbPath} (ustaw DATA_DIR albo EVAL_DB).`);
  process.exit(2);
}

const goldens = readFileSync(goldensPath, 'utf8').split('\n').filter(Boolean).map((l, i) => {
  try { return JSON.parse(l); } catch { console.error(`goldens: nieparsowalna linia ${i + 1}`); process.exit(2); }
});

const db = openDb(dbPath);
const ctx = { db, llm: null, openspg: null, log: console }; // FTS5-only: deterministycznie i za darmo
const allActive = db.prepare("SELECT namespace FROM kb_registry WHERE status='active'").all().map((r) => r.namespace);
let hit1 = 0, hit5 = 0, mrrSum = 0, negOk = 0, negTotal = 0;
const misses = [];

for (const g of goldens) {
  const ns = g.namespaces && g.namespaces.length ? g.namespaces : allActive;
  const res = await hybridSearch(ctx, {
    query: g.question,
    namespaces: ns,
    allowedNamespaces: ns, // eval ufa goldensom; deny-by-default zostaje w produkcyjnych ścieżkach
    limit: 10,
    mode: 'hybrid',
  });
  const results = res.results ?? res;
  if (g.negative) {
    negTotal++;
    const top = results[0]?.score ?? 0;
    if (!results.length || top < minScore) negOk++;
    else misses.push({ q: g.question, kind: 'negative-hit', top: results[0]?.id });
    continue;
  }
  const expected = [...new Set(g.expectedIds ?? [])];
  // trafienie = id wyniku LUB doc_id jego dokumentu pasuje (dokładnie albo prefiksem) do oczekiwanych
  const docIdOf = (id) => db.prepare('SELECT doc_id FROM chunks_mirror WHERE id = ?').get(id)?.doc_id ?? null;
  const matches = (r) => {
    const ids = [r.id, docIdOf(r.id)].filter(Boolean);
    return expected.some((e) => ids.some((x) => x === e || x.startsWith(e)));
  };
  const rank = results.findIndex(matches);
  if (rank === 0) hit1++;
  if (rank >= 0 && rank < 5) hit5++;
  if (rank >= 0) mrrSum += 1 / (rank + 1);
  else misses.push({ q: g.question, kind: 'miss', got: results.slice(0, 3).map((r) => r.id) });
}

const positives = goldens.length - negTotal;
const report = {
  goldens: goldens.length,
  positives,
  negatives: negTotal,
  hit1: positives ? +(hit1 / positives).toFixed(3) : null,
  hit5: positives ? +(hit5 / positives).toFixed(3) : null,
  mrr: positives ? +(mrrSum / positives).toFixed(3) : null,
  negativeAccuracy: negTotal ? +(negOk / negTotal).toFixed(3) : null,
  misses,
};
console.log(JSON.stringify(report, null, 2));

const minHit5 = process.env.EVAL_MIN_HIT5 ? Number(process.env.EVAL_MIN_HIT5) : null;
if (minHit5 !== null && report.hit5 !== null && report.hit5 < minHit5) {
  console.error(`FAIL: hit@5 ${report.hit5} < próg ${minHit5}`);
  process.exit(1);
}
