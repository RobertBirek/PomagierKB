#!/usr/bin/env node
// PomagierKB — eval retrievalu na goldens (hit@1/hit@5/MRR + negatywy + routing).
// Użycie: DATA_DIR=./data node tools/eval/run-eval.mjs [plik.jsonl | katalog]
//   bez argumentu: katalog tools/eval/goldens/ (wszystkie *.jsonl), fallback goldens.jsonl.
// Format wiersza:
//   {"question":"...", "expectedIds":["CHUNK_..."|"DOC_..."], "namespaces":["Ns"],
//    "expectedNamespace":"Ns", "mustContain":["21000 lm"], "kind":"paraphrase",
//    "negative":false}
//   negative:true = pytanie SPOZA bazy — zalicza się, gdy PRODUKCYJNA bramka odmowy
//     (packages/shared/src/answer/gate.ts) odrzuciłaby ten wynik.
//   mustContain = fragmenty, które muszą wystąpić w treści któregoś z 5 najlepszych
//     chunków (test „retrieval realnie wydobył fakt", nie tylko trafił id).
//   requireAllDocs:true = pytanie WIELOKROKOWE: odpowiedź wymaga złożenia treści z KILKU
//     dokumentów, więc zaliczenie wymaga obecności KAŻDEGO z oczekiwanych dokumentów
//     w top-5. Bez tej flagi hit@5 zalicza trafienie w JEDEN z oczekiwanych id, co dla
//     multihopu byłoby miarą fałszywie optymistyczną: pytanie „co zrobić, gdy backup padł
//     i trzeba odtworzyć bazę" wyglądałoby na spełnione, gdy retrieval znalazł sam runbook
//     backupu i nic o odtwarzaniu.
// Kanały: EVAL_CHANNELS=fts (default — deterministycznie, zero kosztu, TYLKO lokalny FTS5)
//         EVAL_CHANNELS=full (pełny hybrid: OpenSPG + embeddings z settings — na żywym stacku).
// Raport JAWNIE mówi, który tryb mierzy — wynik 'fts' to jakość fallbacku, nie hybrydu.
//
// BRAMKI (D8-06): domyślnie WŁĄCZONE i kończą exit 1. Progi nadpisywalne przez
// EVAL_MIN_HIT5 / EVAL_MIN_MRR / EVAL_MIN_NEG / EVAL_MIN_NS; EVAL_NO_GATE=1 wyłącza
// całkowicie (tylko do eksploracji — nigdy w CI). Zbiór bez pozytywów albo bez
// negatywów też kończy się porażką: „brak progu" nie może znaczyć „zielono".
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '@pomagierkb/shared/db';
import { evaluateRelevanceGate, hybridSearch, resolveMinRelevance } from '@pomagierkb/shared/answer';

const arg = process.argv[2] ?? process.env.GOLDENS_FILE ?? null;
const dataDir = process.env.DATA_DIR ?? './data';
const dbPath = process.env.EVAL_DB ?? join(dataDir, 'db', 'kag.db');
const channels = process.env.EVAL_CHANNELS === 'full' ? 'full' : 'fts';
const noGate = process.env.EVAL_NO_GATE === '1';
const num = (env, fallback) => (process.env[env] ? Number(process.env[env]) : fallback);
const thresholds = {
  hit5: num('EVAL_MIN_HIT5', 0.8),
  mrr: num('EVAL_MIN_MRR', 0.5),
  // Bramka TWARDA tylko dla pytań spoza dziedziny — to była pierwotna funkcja bramki
  // odmowy i pomiar 2026-09-07 potwierdza, że działa (24/25).
  negativeAccuracy: num('EVAL_MIN_NEG', 0.9),
  // Near-miss (ta sama dziedzina, treści BRAK) NIE ma twardego progu: pomiar na 50
  // pytaniach pokazał, że pasmo near-miss 0.666-0.762 pokrywa się z on-topic
  // 0.702-0.874 niemal całkowicie, więc żaden próg skalarny ich nie rozdzieli.
  // Metryka jest RAPORTOWANA, żeby regresja była widoczna; obroną jest wymóg cytowań.
  nearMissAccuracy: num('EVAL_MIN_NEARMISS', 0),
  namespaceAccuracy: num('EVAL_MIN_NS', 0.9),
  // Multihop RAPORTOWANY bez twardego progu — dokładnie z tego powodu, dla którego
  // near-miss go nie ma: metryka jest nowa i niestrojona, a bramka postawiona „na oko"
  // albo blokuje bez powodu, albo daje fałszywą zieloność. Próg dopiszemy, gdy pomiar
  // na kilku przebiegach pokaże, jaki poziom jest realny.
  multihopCoverage: num('EVAL_MIN_MULTIHOP', 0),
};
// Próg trafności bramki — ta sama funkcja co produkcja (bez ustawienia = default 0.7).
const minRelevance = resolveMinRelevance(num('EVAL_MIN_RELEVANCE', null));

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
let nmOk = 0, nmTotal = 0;
let mhOk = 0, mhTotal = 0; // wielokrokowe: pokrycie WSZYSTKICH oczekiwanych dokumentów
let contentChecked = 0, contentOk = 0;
const misses = [];
// Pytania z "requires":"full" mierzą zdolność kanału SEMANTYCZNEGO (angielski, literówki,
// odległe parafrazy) — w trybie 'fts' są pomijane, bo mierzyłyby brak kanału, nie regresję.
const skipped = [];
/** Statystyki per rodzaj pytania (parafraza/keyword/EN/typo/bez-diakrytyków/…). */
const perKind = {};
const bump = (kind, field) => {
  const k = kind ?? 'unspecified';
  perKind[k] ??= { total: 0, hit5: 0, mrrSum: 0, negOk: 0 };
  perKind[k][field] = (perKind[k][field] ?? 0) + 1;
};

for (const g of goldens) {
  if (g.requires === 'full' && channels !== 'full') { skipped.push(g.question); continue; }
  const ns = g.namespaces && g.namespaces.length ? g.namespaces : allActive;
  const res = await hybridSearch(ctx, {
    query: g.question,
    namespaces: ns,
    // Eval ŚWIADOMIE omija deny-by-default: goldens są artefaktem repozytorium, a nie
    // wejściem użytkownika, więc „dozwolone" = „proszone". Deny-by-default obowiązuje
    // w ścieżkach produkcyjnych (profil klucza MCP / role panelu) i nie jest tu mierzone.
    allowedNamespaces: ns,
    limit: 10,
    mode: 'hybrid',
  });
  const results = res.results ?? res;
  bump(g.kind, 'total');
  if (g.negative) {
    const isNearMiss = String(g.kind ?? '').includes('near-miss');
    if (isNearMiss) nmTotal++; else negTotal++;
    // Ta sama reguła co produkcyjna bramka odmowy — metryka mierzy TRAFNOŚĆ,
    // a nie to, które kanały akurat działały (D8-06).
    const gate = evaluateRelevanceGate({
      resultCount: results.length,
      semanticScore: res.topVectorScore ?? null,
      lexicalStrict: res.lexicalStrict ?? false,
      minRelevance,
    });
    if (!gate.pass) { if (isNearMiss) nmOk++; else negOk++; bump(g.kind, 'negOk'); }
    else if (!isNearMiss) misses.push({ q: g.question, kind: 'negative-hit', top: results[0]?.id, gate });
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
  // Multihop: KAŻDY oczekiwany dokument musi być w top-5, nie którykolwiek.
  if (g.requireAllDocs === true) {
    mhTotal++;
    const top5 = results.slice(0, 5).map((r) => [r.id, docIdOf(r.id)].filter(Boolean));
    const covered = expected.filter((e) => top5.some((ids) => ids.some((x) => x === e || x.startsWith(e))));
    if (covered.length === expected.length) mhOk++;
    else misses.push({ q: g.question, kind: 'multihop-partial', missing: expected.filter((e) => !covered.includes(e)) });
  }
  if (rank === 0) hit1++;
  if (rank >= 0 && rank < 5) { hit5++; bump(g.kind, 'hit5'); }
  if (rank >= 0) { mrrSum += 1 / (rank + 1); perKind[g.kind ?? 'unspecified'].mrrSum += 1 / (rank + 1); }
  else misses.push({ q: g.question, kind: 'miss', got: results.slice(0, 3).map((r) => r.id) });
  // mustContain: czy treść z top-5 REALNIE zawiera fakt (antyhalucynacyjna kotwica)
  if (Array.isArray(g.mustContain) && g.mustContain.length > 0) {
    contentChecked++;
    const blob = results
      .slice(0, 5)
      .map((r) => db.prepare('SELECT content FROM chunks_mirror WHERE id = ?').get(r.id)?.content ?? '')
      .join('\n')
      .toLowerCase();
    const missing = g.mustContain.filter((frag) => !blob.includes(String(frag).toLowerCase()));
    if (missing.length === 0) contentOk++;
    else misses.push({ q: g.question, kind: 'must-contain', missing });
  }
  // trafność routingu cross-KB: czy top-1 pochodzi z oczekiwanej bazy
  if (g.expectedNamespace) {
    nsChecked++;
    if (results[0]?.namespace === g.expectedNamespace) nsCorrect++;
  }
}

const evaluated = goldens.length - skipped.length;
const positives = evaluated - negTotal;
const report = {
  channels, // 'fts' = jakość FALLBACKU lokalnego; 'full' = produkcyjny hybrid
  files,
  goldens: goldens.length,
  evaluated,
  skippedRequiresFull: skipped.length,
  positives,
  negatives: negTotal,
  minRelevance,
  hit1: positives ? +(hit1 / positives).toFixed(3) : null,
  hit5: positives ? +(hit5 / positives).toFixed(3) : null,
  mrr: positives ? +(mrrSum / positives).toFixed(3) : null,
  negativeAccuracy: negTotal ? +(negOk / negTotal).toFixed(3) : null,
  nearMissAccuracy: nmTotal ? +(nmOk / nmTotal).toFixed(3) : null,
  // Odsetek pytań wielokrokowych, dla których KAŻDY wymagany dokument wszedł do top-5.
  multihopCoverage: mhTotal ? +(mhOk / mhTotal).toFixed(3) : null,
  multihopChecked: mhTotal,
  namespaceAccuracy: nsChecked ? +(nsCorrect / nsChecked).toFixed(3) : null,
  mustContainAccuracy: contentChecked ? +(contentOk / contentChecked).toFixed(3) : null,
  perKind: Object.fromEntries(
    Object.entries(perKind).map(([k, v]) => [
      k,
      { total: v.total, hit5: v.hit5, negOk: v.negOk, mrr: v.total ? +(v.mrrSum / v.total).toFixed(3) : null },
    ]),
  ),
  misses,
  skipped,
};
console.log(JSON.stringify(report, null, 2));

if (noGate) {
  console.error('EVAL_NO_GATE=1 — bramki wyłączone, wynik NIE jest kotwicą jakości.');
  process.exit(0);
}

const failures = [];
// Zbiór bez pozytywów albo bez negatywów niczego nie kotwiczy — to porażka konfiguracji,
// nie „zielony" wynik (D8-06: metryka null nie może przechodzić po cichu).
if (positives === 0) failures.push('zbiór goldens nie zawiera ANI JEDNEGO pozytywu');
if (negTotal === 0) failures.push('zbiór goldens nie zawiera ANI JEDNEGO negatywu (bramka odmowy niemierzona)');
for (const [metric, min] of Object.entries(thresholds)) {
  const value = report[metric];
  if (value === null || value === undefined) continue; // np. namespaceAccuracy bez expectedNamespace
  if (Number.isFinite(min) && value < min) failures.push(`${metric} ${value} < próg ${min}`);
}
if (report.mustContainAccuracy !== null && report.mustContainAccuracy < 1) {
  failures.push(`mustContainAccuracy ${report.mustContainAccuracy} < 1 (retrieval nie wydobył wymaganych faktów)`);
}
if (failures.length > 0) {
  console.error(`FAIL:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.error('OK: wszystkie bramki evalu spełnione.');
