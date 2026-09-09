#!/usr/bin/env node
// Build bazy + quality gate przez API: POST /kbs/:ns/build → czeka na akcję → POST /kbs/:ns/quality → raport.
// Użycie: node tools/kb-import/build.mjs --namespace SubiektKB [--force] [--no-quality]

import { PanelClient, expectOk } from './lib/client.mjs';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const namespace = opt('--namespace');
const force = args.includes('--force');
const quality = !args.includes('--no-quality');
if (!namespace) {
  console.error('użycie: build.mjs --namespace <NS> [--force] [--no-quality]');
  process.exit(2);
}
const client = await new PanelClient().open();
try {
  const started = Date.now();
  const res = await client.post(`/api/v1/kbs/${namespace}/build`, { force });
  const data = expectOk(res, 'POST /kbs/:ns/build');
  console.log(`build ${namespace}: akcja ${data.actionId}`);
  const action = await client.waitAction(data.actionId, { onLog: (lines) => lines.forEach((l) => console.log(`  | ${l}`)) });
  console.log(`build zakończony: ${action.status} po ${((Date.now() - started) / 60000).toFixed(1)} min`);
  if (action.status !== 'success') process.exitCode = 1;
  if (quality && action.status === 'success') {
    const q = expectOk(await client.post(`/api/v1/kbs/${namespace}/quality`, {}), 'POST /kbs/:ns/quality');
    const qa = await client.waitAction(q.actionId, { onLog: (lines) => lines.forEach((l) => console.log(`  | ${l}`)) });
    console.log(`quality gate: ${qa.status}`);
    const rep = await client.get(`/api/v1/kbs/${namespace}/quality`);
    console.log(JSON.stringify(rep.body?.data ?? rep.body, null, 1).slice(0, 4000));
  }
  const kb = expectOk(await client.get(`/api/v1/kbs/${namespace}`), 'GET /kbs/:ns');
  console.log(JSON.stringify({ status: kb.kb?.status ?? kb.status, totals: kb.kb?.totals ?? kb.totals ?? kb }, null, 1).slice(0, 800));
} finally {
  await client.close();
}
