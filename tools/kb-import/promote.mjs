#!/usr/bin/env node
// Promocja draftów z importu: po intakeId/draftId ze state.json (nie po namespace — źle zaroutowane
// drafty by umknęły). Krok 1: PATCH namespace/documentCategory gdy różne od manifestu.
// Krok 2: POST /drafts/bulk {promote, dryRun:true} partiami ≤50 → raport → apply (bez --dry-run).
// Użycie: node tools/kb-import/promote.mjs --dir <out/docs> --namespace SubiektKB [--dry-run] [--exclude <plik z listą draftId do pominięcia>]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PanelClient, expectOk } from './lib/client.mjs';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const dir = opt('--dir');
const namespace = opt('--namespace');
const dryRun = args.includes('--dry-run');
const excludePath = opt('--exclude');
if (!dir || !namespace) {
  console.error('użycie: promote.mjs --dir <katalog ze state.json> --namespace <NS> [--dry-run] [--exclude plik]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const statePath = join(dir, 'state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
// Osobny plik na wynik promocji — upload.mjs może równolegle pisać state.json (brak wyścigu).
const promotedPath = join(dir, 'promoted.json');
const promotedSet = new Set(existsSync(promotedPath) ? JSON.parse(readFileSync(promotedPath, 'utf8')) : []);
const savePromoted = () => writeFileSync(promotedPath, JSON.stringify([...promotedSet], null, 2));
const exclude = new Set(excludePath && existsSync(excludePath) ? readFileSync(excludePath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : []);
const byFile = new Map(manifest.entries.map((e) => [e.file, e]));

const client = await new PanelClient().open();
try {
  console.log(`zalogowano jako ${client.user}; dryRun=${dryRun}`);
  const candidates = [];
  let fixed = 0;
  for (const [file, s] of Object.entries(state.items)) {
    if (!s.draftId || promotedSet.has(s.draftId)) continue;
    if (exclude.has(s.draftId)) {
      console.log(`- ${file}: pominięty (lista wykluczeń)`);
      continue;
    }
    const r = await client.get(`/api/v1/drafts/${s.draftId}`);
    if (r.status !== 200) {
      console.error(`! ${file}: GET draft → ${r.status}`);
      continue;
    }
    const d = r.body.data.draft ?? r.body.data;
    if (d.status !== 'pending') {
      if (d.status === 'promoted') promotedSet.add(s.draftId);
      console.log(`- ${file}: status ${d.status} — pomijam`);
      continue;
    }
    const want = byFile.get(file);
    const patch = {};
    if (d.namespace !== namespace) patch.namespace = namespace;
    if (want?.category && d.documentCategory !== want.category) patch.documentCategory = want.category;
    if (Object.keys(patch).length > 0 && !dryRun) {
      const pr = await client.patch(`/api/v1/drafts/${s.draftId}`, patch);
      if (pr.status === 200) {
        fixed += 1;
        console.log(`~ ${file}: ${JSON.stringify(patch)}`);
      } else {
        console.error(`! ${file}: PATCH → ${pr.status} ${JSON.stringify(pr.body?.error ?? '').slice(0, 200)}`);
      }
    } else if (Object.keys(patch).length > 0) {
      console.log(`~ (dry) ${file}: ${JSON.stringify(patch)}`);
    }
    candidates.push({ file, id: s.draftId });
  }
  console.log(`kandydatów do promocji: ${candidates.length}, poprawionych metadanych: ${fixed}`);

  let promoted = 0;
  for (let i = 0; i < candidates.length; i += 50) {
    const batch = candidates.slice(i, i + 50);
    const ids = batch.map((c) => c.id);
    const dry = expectOk(await client.post('/api/v1/drafts/bulk', { op: 'promote', ids, dryRun: true }), 'bulk dry-run');
    const results = dry.results ?? dry.items ?? [];
    const notOk = results.filter((x) => x.ok === false || (x.status && x.status !== 'ok'));
    for (const x of notOk) console.log(`  ✗ ${x.id}: ${x.reason ?? x.error ?? JSON.stringify(x)}`);
    if (dryRun) continue;
    const okIds = results.filter((x) => x.ok !== false && (!x.status || x.status === 'ok')).map((x) => x.id);
    if (okIds.length === 0) continue;
    const applied = expectOk(await client.post('/api/v1/drafts/bulk', { op: 'promote', ids: okIds, dryRun: false }), 'bulk apply');
    const appliedOk = (applied.results ?? applied.items ?? []).filter((x) => x.ok !== false && (!x.status || x.status === 'ok'));
    for (const x of appliedOk) promotedSet.add(x.id);
    promoted += appliedOk.length;
    savePromoted();
    console.log(`partia ${i / 50 + 1}: promowano ${appliedOk.length}/${ids.length}`);
  }
  console.log(`razem promowano: ${promoted}`);
} finally {
  savePromoted();
  await client.close();
}
