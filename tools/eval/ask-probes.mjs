#!/usr/bin/env node
// Zadaje pytania sondujące (tools/eval/probes/<Ns>.jsonl) przez PRODUKCYJNE /api/v1/ask kontem E2E,
// żeby tabela `answers` miała świeżą, reprezentatywną próbkę do sędziego (tools/eval/judge.mjs).
// Wypisuje skrót: czas, odmowa/odpowiedź, pewność, źródła cytowań. Nie ocenia — od tego jest sędzia.
// Użycie: node tools/eval/ask-probes.mjs tools/eval/probes/SubiektKB.jsonl [--limit N] [--out raport.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { PanelClient } from '../kb-import/lib/client.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const limit = Number(opt('--limit', '1000'));
const delayMs = Number(opt('--delay-ms', '6500')); // /ask ma własny limit ~10/min per użytkownik (429)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outPath = opt('--out');
if (!file) {
  console.error('użycie: ask-probes.mjs <probes.jsonl> [--limit N] [--out raport.json]');
  process.exit(2);
}
const probes = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .slice(0, limit);
const client = await new PanelClient().open();
const results = [];
try {
  for (const p of probes) {
    const t0 = Date.now();
    let raw;
    for (let attempt = 1; attempt <= 3; attempt++) {
      raw = await client.page.evaluate(async (q) => {
        const res = await fetch('/api/v1/ask', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: q }),
        });
        return { status: res.status, text: await res.text() };
      }, p.q);
      if (raw.status !== 429) break;
      await sleep(30_000 * attempt);
    }
    const m = /event: result\ndata: (.*)/.exec(raw.text);
    const d = m ? JSON.parse(m[1]) : null;
    const sources = [...new Set((d?.citations ?? []).map((c) => String(c.title).split(' — ')[0]))];
    const r = {
      q: p.q,
      kind: p.kind,
      ms: Date.now() - t0,
      status: raw.status,
      noAnswer: d?.noAnswer ?? null,
      confidence: d?.confidence ?? null,
      citations: (d?.citations ?? []).length,
      sources,
      answerId: d?.answerId ?? null,
      answer: (d?.answer ?? '').slice(0, 400),
    };
    results.push(r);
    await sleep(delayMs);
    console.log(
      `${String(r.ms).padStart(6)} ms | ${r.noAnswer ? 'ODMOWA' : 'odp.  '} | conf ${r.confidence ?? '-'} | cyt ${r.citations} | ${r.kind.padEnd(9)} | ${p.q.slice(0, 70)} → ${sources.join(', ')}`,
    );
  }
} finally {
  await client.close();
}
if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 2));
const answered = results.filter((r) => !r.noAnswer).length;
console.log(
  `\npytania: ${results.length}, odpowiedzi: ${answered}, odmowy: ${results.length - answered}, mediana ms: ${[...results].sort((a, b) => a.ms - b.ms)[Math.floor(results.length / 2)]?.ms}`,
);
