#!/usr/bin/env node
// PomagierKB — eval retrievalu na goldens (hit@1/hit@5/MRR + trafność namespace).
// Użycie: DATA_DIR=./data node tools/eval/run-eval.mjs [plik.jsonl | katalog]
//   bez argumentu: katalog tools/eval/goldens/ (wszystkie *.jsonl), fallback goldens.jsonl.
// Format wiersza:
//   {"question":"...", "expectedIds":["CHUNK_..."|"DOC_..."], "namespaces":["Ns"],
//    "expectedNamespace":"Ns", "negative":false}
//   negative:true = pytanie SPOZA bazy — zalicza się, gdy retrieval NIE zwraca wyniku ≥ minScore.
// Kanały: EVAL_CHANNELS=fts (default — deterministycznie, zero kosztu, TYLKO lokalny FTS5)
//         EVAL_CHANNELS=full (pełny hybrid: OpenSPG + embeddings z settings — na żywym stacku).
// Raport JAWNIE mówi, który tryb mierzy — wynik 'fts' to jakość fallbacku, nie hybrydu.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '@pomagierkb/shared/db';
import { hybridSearch } from '@pomagierkb/shared/answer';

const arg = process.argv[2] ?? process.env.GOLDENS_FILE ?? null;
const dataDir = process.env.DATA_DIR ?? './data';
const dbPath = process.env.EVAL_DB ?? join(dataDir, 'db', 'kag.db');
const minScore = Number(process.env.EVAL_MIN_SCORE ?? '0.01');
const channels = process.env.EVAL_CHANNELS === 'full' ? 'full' : 'fts';

function goldenFiles() {
  const defaultDir = join('tools', 'eval', 'goldens');
  const target = arg ?? (existsSync(defaultDir) ? defaultDir : 'goldens.jsonl');
  if (!existsSync(target)) {
    console.error(`Brak goldens: ${target} — utwórz tools/eval/goldens/<Ns>.jsonl (workflow: docs/operator-manual.md).`);
    process.exit(2);
  }
  if (statSync(target).isDirectory()) {
    const files = readdirSync(target).filter((f) => f.endsWith('.jsonl')).sort().map((f) => join(target, f));
    if (files.length === 0) {
      console.error(`Katalog ${target} nie zawiera plików .jsonl.`);
      process.exit(2);
    }
    return files;
  }
  return [target];
}

const files = goldenFiles();
if (!existsSync(dbPath)) {
  console.error(`Brak bazy: ${dbPath} (ustaw DATA_DIR albo EVAL_DB).`);
  process.exit(2);
}

const goldens = files.flatMap((file) =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try { return { ...JSON.parse(l), _file: file }; }
    catch { console.error(`goldens ${file}: nieparsowalna linia ${i + 1}`); process.exit(2); }
  }),
);

const db = openDb(dbPath);
let llm = null;
let openspg = null;
if (channels === 'full') {
  // Pełny hybrid: klienci z settings/env — mierzy PRODUKCYJNĄ ścieżkę (koszt embeddingów!).
  const { OpenSpgClient } = await import('@pomagierkb/shared/openspg');
  const { createLlmClient } = await import('@pomagierkb/shared/llm');
  const { unseal } = await import('@pomagierkb/shared/crypto');
  const encKey = process.env.TOKEN_ENC_KEY;
  const read = (key) => {
    const row = db.prepare('SELECT value_json, is_secret FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    const val = JSON.parse(row.value_json);
    if (row.is_secret === 1) {
      if (!encKey) return null;
      return JSON.parse(unseal(val.sealed, encKey));
    }
    return val;
  };
  const chatCfg = read('llm.chat');
  const embedCfg = read('llm.embeddings') ?? chatCfg;
  if (embedCfg) {
    const c = createLlmClient(embedCfg);
    llm = { chat: (r) => c.chat(r), embed: (t) => c.embed(t) };
  }
  const base = process.env.OPENSPG_BASE_URL;
  if (base) {
    openspg = new OpenSpgClient({
      baseUrl: base,
      account: process.env.OPENSPG_ACCOUNT ?? 'openspg',
      password: process.env.OPENSPG_PASSWORD ?? '',
    });
  }
  if (llm === null || openspg === null) {
    console.error('EVAL_CHANNELS=full wymaga: llm.embeddings w settings (+TOKEN_ENC_KEY) i OPENSPG_BASE_URL/_ACCOUNT/_PASSWORD.');
    process.exit(2);
  }
}
const ctx = { db, llm, openspg, log: console };
const allActive = db.prepare("SELECT namespace FROM kb_registry WHERE status='active'").all().map((r) => r.namespace);
let hit1 = 0, hit5 = 0, mrrSum = 0, negOk = 0, negTotal = 0, nsChecked = 0, nsCorrect = 0;
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
  // trafność routingu cross-KB: czy top-1 pochodzi z oczekiwanej bazy
  if (g.expectedNamespace) {
    nsChecked++;
    if (results[0]?.namespace === g.expectedNamespace) nsCorrect++;
  }
}

const positives = goldens.length - negTotal;
const report = {
  channels, // 'fts' = jakość FALLBACKU lokalnego; 'full' = produkcyjny hybrid
  files,
  goldens: goldens.length,
  positives,
  negatives: negTotal,
  hit1: positives ? +(hit1 / positives).toFixed(3) : null,
  hit5: positives ? +(hit5 / positives).toFixed(3) : null,
  mrr: positives ? +(mrrSum / positives).toFixed(3) : null,
  negativeAccuracy: negTotal ? +(negOk / negTotal).toFixed(3) : null,
  namespaceAccuracy: nsChecked ? +(nsCorrect / nsChecked).toFixed(3) : null,
  misses,
};
console.log(JSON.stringify(report, null, 2));

const minHit5 = process.env.EVAL_MIN_HIT5 ? Number(process.env.EVAL_MIN_HIT5) : null;
if (minHit5 !== null && report.hit5 !== null && report.hit5 < minHit5) {
  console.error(`FAIL: hit@5 ${report.hit5} < próg ${minHit5}`);
  process.exit(1);
}
