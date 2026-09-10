#!/usr/bin/env node
// Odpowiedzi OFFLINE na pytania sondujące: answerQuestion z packages/shared na KOPII bazy panelu
// (better-sqlite3 backup → plik tymczasowy), z żywym OpenSPG i LLM z settings. Produkcja nietknięta:
// żadnych wierszy answers/learning_gaps, zero cache panelu. Do iterowania promptu odpowiedzi
// (answer-vN) PRZED deployem — 2026-09-10 answer-v3 poszedł na produkcję bez tego i 31/40 sond
// wpadło w fałszywe odmowy zakresu.
// Użycie: (set -a; . deploy/kag/.env; set +a; OPENSPG_BASE_URL=http://172.23.0.5:8887 \
//   DATA_DIR=/srv/kag-data/kag/panel node tools/eval/answer-offline.mjs tools/eval/probes/SubiektKB.jsonl \
//   [--limit N] [--ns SubiektKB] [--out raport.json])
// Wymaga zbudowanego dist packages/shared (npm run build -w packages/shared) — jak run-eval.mjs.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '@pomagierkb/shared/db';
import { answerQuestion, ANSWER_PROMPT_VERSION } from '@pomagierkb/shared/answer';
import { OpenSpgClient } from '@pomagierkb/shared/openspg';
import { createLlmClient } from '@pomagierkb/shared/llm';
import { unseal } from '@pomagierkb/shared/crypto';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
if (!file) {
  console.error('użycie: answer-offline.mjs <probes.jsonl> [--limit N] [--ns NS] [--out raport.json]');
  process.exit(2);
}
const limit = Number(opt('--limit', '1000'));
const ns = opt('--ns', 'SubiektKB');
const outPath = opt('--out');
const dataDir = process.env.DATA_DIR ?? './data';
const srcDb = join(dataDir, 'db', 'kag.db');

// Kopia bazy: backup API robi spójny snapshot (WAL) bez blokowania panelu.
const tmp = mkdtempSync(join(tmpdir(), 'kag-offline-'));
const copyPath = join(tmp, 'kag.db');
{
  const src = new Database(srcDb, { readonly: true });
  await src.backup(copyPath);
  src.close();
}
const db = openDb(copyPath);

const encKey = process.env.TOKEN_ENC_KEY;
const read = (key) => {
  const row = db.prepare('SELECT value_json, is_secret FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  const val = JSON.parse(row.value_json);
  if (row.is_secret === 1) return encKey ? JSON.parse(unseal(val.sealed, encKey)) : null;
  return val;
};
const chatCfg = read('llm.chat');
const embedCfg = read('llm.embeddings') ?? chatCfg;
const base = process.env.OPENSPG_BASE_URL;
if (!chatCfg || !embedCfg || !base) {
  console.error('wymaga: llm.chat i llm.embeddings w settings (+TOKEN_ENC_KEY) oraz OPENSPG_BASE_URL/_ACCOUNT/_PASSWORD');
  process.exit(2);
}
const chat = createLlmClient(chatCfg);
const embed = createLlmClient(embedCfg);
const llm = { chat: (r) => chat.chat(r), embed: (t) => embed.embed(t) };
const openspg = new OpenSpgClient({
  baseUrl: base,
  account: process.env.OPENSPG_ACCOUNT ?? 'openspg',
  password: process.env.OPENSPG_PASSWORD ?? '',
});
const ctx = { db, llm, openspg, log: { warn: () => undefined } };

const probes = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(0, limit);
console.log(`prompt ${ANSWER_PROMPT_VERSION}, ns ${ns}, pytań ${probes.length}, kopia bazy ${copyPath}`);
const results = [];
for (const p of probes) {
  const t0 = Date.now();
  let r;
  try {
    r = await answerQuestion(ctx, { question: p.q, allowedNamespaces: [ns], namespaces: [ns], source: 'mcp' });
  } catch (err) {
    console.log(`ERR | ${p.q.slice(0, 70)} | ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  const row = {
    q: p.q,
    kind: p.kind ?? null,
    ms: Date.now() - t0,
    noAnswer: r.noAnswer,
    confidence: r.confidence,
    citations: r.citations.length,
    warnings: r.warnings,
    answer: r.answer.slice(0, 600),
  };
  results.push(row);
  console.log(
    `${String(row.ms).padStart(6)} ms | ${row.noAnswer ? 'ODMOWA' : 'odp.  '} | conf ${row.confidence.toFixed(2)} | cyt ${row.citations} | ${String(row.kind).padEnd(9)} | ${p.q.slice(0, 64)} → ${row.answer.slice(0, 70).replace(/\n/g, ' ')}`,
  );
}
if (outPath) writeFileSync(outPath, JSON.stringify({ promptVersion: ANSWER_PROMPT_VERSION, results }, null, 2));
const refused = results.filter((r) => r.noAnswer);
console.log(`\npytania: ${results.length}, odmowy: ${refused.length} (${refused.map((r) => r.kind).join(', ')})`);
