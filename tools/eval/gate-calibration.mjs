#!/usr/bin/env node
// Kalibracja bramki odmowy (packages/shared/src/answer/gate.ts): rozkład topVectorScore dla
// pytań on-topic / near-miss / off-topic z goldens na PRODUKCYJNYM hybrydzie.
// Użycie (jak EVAL_CHANNELS=full): TOKEN_ENC_KEY=… OPENSPG_BASE_URL=… DATA_DIR=… node tools/eval/gate-calibration.mjs
// Wypisuje percentyle i macierz błędów dla kandydatów progu — bez zmiany ustawień.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '@pomagierkb/shared/db';
import { hybridSearch } from '@pomagierkb/shared/answer';
import { OpenSpgClient } from '@pomagierkb/shared/openspg';
import { createLlmClient } from '@pomagierkb/shared/llm';
import { unseal } from '@pomagierkb/shared/crypto';

const dataDir = process.env.DATA_DIR ?? './data';
const db = openDb(process.env.EVAL_DB ?? join(dataDir, 'db', 'kag.db'));
const encKey = process.env.TOKEN_ENC_KEY;
const read = (key) => {
  const row = db.prepare('SELECT value_json, is_secret FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  const val = JSON.parse(row.value_json);
  return row.is_secret === 1 ? (encKey ? JSON.parse(unseal(val.sealed, encKey)) : null) : val;
};
const embedCfg = read('llm.embeddings') ?? read('llm.chat');
const c = createLlmClient(embedCfg);
const llm = { chat: (r) => c.chat(r), embed: (t) => c.embed(t) };
const openspg = new OpenSpgClient({ baseUrl: process.env.OPENSPG_BASE_URL, account: process.env.OPENSPG_ACCOUNT ?? 'openspg', password: process.env.OPENSPG_PASSWORD ?? '' });
const ctx = { db, llm, openspg, log: { ...console, info() {}, debug() {} } };

const dir = 'tools/eval/goldens';
const goldens = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const allActive = db.prepare("SELECT namespace FROM kb_registry WHERE status='active'").all().map((r) => r.namespace);
const samples = [];
for (const g of goldens) {
  const ns = g.namespaces?.length ? g.namespaces : allActive;
  const res = await hybridSearch(ctx, { query: g.question, namespaces: ns, allowedNamespaces: ns, limit: 10, mode: 'hybrid' });
  const cls = g.negative ? (String(g.kind ?? '').includes('near-miss') ? 'near-miss' : 'off-topic') : 'on-topic';
  samples.push({ q: g.question, cls, ns: ns.join('+'), score: res.topVectorScore ?? null });
}
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
for (const cls of ['on-topic', 'near-miss', 'off-topic']) {
  const s = samples.filter((x) => x.cls === cls && x.score !== null).map((x) => x.score).sort((a, b) => a - b);
  console.log(`${cls.padEnd(10)} n=${s.length} min=${s[0]?.toFixed(3)} p10=${pct(s, 10)?.toFixed(3)} p50=${pct(s, 50)?.toFixed(3)} p90=${pct(s, 90)?.toFixed(3)} max=${s.at(-1)?.toFixed(3)}`);
}
console.log('\npróg → fałszywe odmowy on-topic | fałszywe odpowiedzi off-topic');
for (const t of [0.66, 0.68, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8]) {
  const on = samples.filter((x) => x.cls === 'on-topic' && x.score !== null);
  const off = samples.filter((x) => x.cls === 'off-topic' && x.score !== null);
  const fr = on.filter((x) => x.score < t).length;
  const fa = off.filter((x) => x.score >= t).length;
  console.log(`${t.toFixed(2)} → ${fr}/${on.length} (${((100 * fr) / on.length).toFixed(0)}%) | ${fa}/${off.length} (${((100 * fa) / off.length).toFixed(0)}%)`);
}
console.log('\nnajniższe on-topic:');
for (const x of samples.filter((x) => x.cls === 'on-topic' && x.score !== null).sort((a, b) => a.score - b.score).slice(0, 8)) console.log(`  ${x.score.toFixed(3)} ${x.ns} ${x.q}`);
console.log('najwyższe off-topic:');
for (const x of samples.filter((x) => x.cls === 'off-topic' && x.score !== null).sort((a, b) => b.score - a.score).slice(0, 10)) console.log(`  ${x.score.toFixed(3)} ${x.ns} ${x.q}`);
