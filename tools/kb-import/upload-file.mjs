#!/usr/bin/env node
// Upload PLIKU (multipart) przez POST /api/v1/content — dla skanów PDF bez warstwy tekstowej,
// które prepare.mjs pomija (ekstrakcję robi wtedy pipeline: Stirling → OCR pol → Tika).
// Użycie: node tools/kb-import/upload-file.mjs --file <ścieżka> [--file <ścieżka>...] [--state <state.json>]
// Zapisuje intakeId/draftId do state.json (klucz = nazwa pliku) — promote.mjs promuje je jak inne.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PanelClient } from './lib/client.mjs';

const args = process.argv.slice(2);
const files = [];
let statePath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') files.push(args[++i]);
  else if (args[i] === '--state') statePath = args[++i];
}
if (files.length === 0) {
  console.error('użycie: upload-file.mjs --file <pdf> [--file ...] [--state state.json]');
  process.exit(2);
}
const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { items: {} };
const save = () => statePath && writeFileSync(statePath, JSON.stringify(state, null, 2));

const client = await new PanelClient().open();
try {
  for (const path of files) {
    const name = basename(path);
    const b64 = readFileSync(path).toString('base64');
    await client.throttle();
    const res = await client.page.evaluate(
      // Wykonuje się w PRZEGLĄDARCE (Playwright) — atob/FormData/Blob to globale strony, nie Node.
      async ({ name, b64 }) => {
        /* global atob, FormData, Blob */
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new Blob([bin], { type: name.toLowerCase().endsWith('.doc') ? 'application/msword' : 'application/pdf' }), name);
        const r = await fetch('/api/v1/content', { method: 'POST', credentials: 'include', body: fd });
        const text = await r.text();
        try {
          return { status: r.status, body: JSON.parse(text) };
        } catch {
          return { status: r.status, body: text };
        }
      },
      { name, b64 },
    );
    if (!(res.status === 200 || res.status === 202) || res.body?.ok !== true) {
      console.error(`! ${name}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      continue;
    }
    const intakeId = res.body.data.intakeId;
    state.items[name] = { intakeId, status: res.body.data.status, draftId: res.body.data.draftId ?? null, sentAt: new Date().toISOString(), title: name };
    save();
    console.log(`+ ${name} → ${intakeId}${res.body.data.deduplicated ? ' (dedup)' : ''}`);
  }
  // polling do stanu terminalnego (OCR bywa długi: deadline pipeline'u 10 min/dokument)
  const pending = () => Object.entries(state.items).filter(([, s]) => s.intakeId && !s.draftId && !['failed_final'].includes(s.status));
  let idle = 0;
  while (pending().length > 0 && idle < 150) {
    let progressed = false;
    for (const [name, s] of pending()) {
      const r = await client.get(`/api/v1/content/${s.intakeId}`);
      if (r.status !== 200) continue;
      const d = r.body.data?.intake ?? r.body.data;
      if (d.status !== s.status) {
        progressed = true;
        console.log(`  ${name}: ${s.status} → ${d.status}${d.extractProvider ? ` (${d.extractProvider}, jakość ${d.extractQuality})` : ''}`);
      }
      s.status = d.status;
      if (d.status === 'drafted') {
        s.draftId = d.draftId;
        console.log(`✓ ${name} → draft ${s.draftId}`);
      } else if (d.status === 'failed') {
        s.status = 'failed_final';
        console.error(`✗ ${name}: ${d.error}: ${d.errorDetail ?? ''}`);
      }
    }
    save();
    idle = progressed ? 0 : idle + 1;
    await new Promise((r) => setTimeout(r, 8000));
  }
} finally {
  save();
  await client.close();
}
