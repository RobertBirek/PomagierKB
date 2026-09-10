#!/usr/bin/env node
// Wycofuje szkice fragmentów, których nie ma już w manifeście (np. po zmianie podziału źródła na inne
// dokumenty): promowany → POST /drafts/:id/withdraw (znika z eksportu przy następnym buildzie),
// pending → reject. Wpis znika ze state.json. Użycie: node tools/kb-import/withdraw-missing.mjs --dir <out/x> [--dry-run]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PanelClient } from './lib/client.mjs';

const args = process.argv.slice(2);
const dir = args[args.indexOf('--dir') + 1];
const dryRun = args.includes('--dry-run');
if (!dir || args.indexOf('--dir') < 0) {
  console.error('użycie: withdraw-missing.mjs --dir <katalog> [--dry-run]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const statePath = join(dir, 'state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const present = new Set(manifest.entries.map((e) => e.file));
const missing = Object.entries(state.items).filter(([file]) => !present.has(file));
console.log(`fragmentów w state: ${Object.keys(state.items).length}, poza manifestem: ${missing.length}${dryRun ? ' (dry-run)' : ''}`);
if (missing.length === 0 || dryRun) {
  for (const [file, s] of missing) console.log(`- ${file} → ${s.draftId ?? s.status}`);
  process.exit(0);
}
const client = await new PanelClient().open();
try {
  for (const [file, s] of missing) {
    if (s.draftId) {
      const d = await client.get(`/api/v1/drafts/${s.draftId}`);
      const status = d.body?.data?.draft?.status;
      let r;
      if (status === 'promoted') r = await client.post(`/api/v1/drafts/${s.draftId}/withdraw`, {});
      else if (status === 'pending') r = await client.post(`/api/v1/drafts/${s.draftId}/reject`, { reason: 'fragment zastąpiony nowym podziałem źródła (kb-import)' });
      console.log(`${file}: ${status} → ${r ? r.status : 'bez zmian'}`);
    }
    delete state.items[file];
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
} finally {
  await client.close();
}
