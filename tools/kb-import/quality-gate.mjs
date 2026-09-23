#!/usr/bin/env node
// Uruchamia SAMĄ bramkę jakości (bez builda) dla bazy wiedzy i wypisuje werdykty checków.
// Użycie: node tools/kb-import/quality-gate.mjs <Namespace>
import { PanelClient } from './lib/client.mjs';
const ns = process.argv[2];
if (!ns) { console.error('użycie: quality-gate.mjs <Namespace>'); process.exit(2); }
const client = await new PanelClient().open();
try {
  const r = await client.post(`/api/v1/kbs/${ns}/quality`, {});
  const actionId = r.body?.data?.actionId;
  if (!actionId) { console.error('start nieudany:', r.status, JSON.stringify(r.body?.error ?? r.body).slice(0, 200)); process.exit(1); }
  for (let i = 0; i < 90; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    const a = await client.get(`/api/v1/actions/${actionId}`);
    const st = a.body?.data?.status ?? a.body?.data?.action?.status;
    if (st && !['running', 'queued', 'pending'].includes(st)) {
      const log = await client.get(`/api/v1/actions/${actionId}/log`);
      const text = typeof log.body === 'string' ? log.body : JSON.stringify(log.body?.data ?? log.body);
      for (const line of text.split('\n')) if (/quality /.test(line)) console.log(line.replace(/^.*\[job\] \S+ /, '').slice(0, 200));
      process.exit(/quality gate: (OK|WARN)/.test(text) ? 0 : 1);
    }
  }
  console.error('timeout'); process.exit(1);
} finally { await client.close(); }
