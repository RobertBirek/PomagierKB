#!/usr/bin/env node
// Luki wiedzy (learning_gaps) z linii poleceń: lista otwartych, eksport do sond harnessu, zamykanie.
// Użycie: node tools/eval/gaps.mjs list
//         node tools/eval/gaps.mjs probes <plik.jsonl>          (otwarte luki → sondy dla answer-offline.mjs)
//         node tools/eval/gaps.mjs resolve <gapId> [<gapId>…]   (wiedza dodana / pytanie odpowiedziane)
//         node tools/eval/gaps.mjs ignore  <gapId> [<gapId>…]   (szum: staging, testy)
import { writeFileSync } from 'node:fs';
import { PanelClient } from '../kb-import/lib/client.mjs';
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('użycie: gaps.mjs list | probes <plik> | resolve <id…> | ignore <id…>'); process.exit(2); }
const client = await new PanelClient().open();
try {
  const open = async () => {
    const r = await client.get('/api/v1/learning/gaps?status=open&limit=100');
    return r.body?.data?.gaps ?? r.body?.data?.items ?? r.body?.data ?? [];
  };
  if (cmd === 'list') {
    for (const g of await open()) console.log(`${g.id} | ${g.kbNamespace ?? g.kb_namespace ?? '-'} | ${g.source ?? '-'} | ${String(g.question).slice(0, 110)}`);
  } else if (cmd === 'probes') {
    const gaps = await open();
    writeFileSync(args[0], gaps.map((g) => JSON.stringify({ q: g.question, kind: `gap:${g.id}` })).join('\n') + '\n');
    console.log(`zapisano ${gaps.length} sond do ${args[0]}`);
  } else if (cmd === 'resolve' || cmd === 'ignore') {
    for (const id of args) { const r = await client.post(`/api/v1/learning/gaps/${id}/${cmd}`, {}); console.log(cmd, id, r.status, r.body?.error?.code ?? ''); }
  } else { console.error('nieznana komenda'); process.exit(2); }
} finally { await client.close(); }
