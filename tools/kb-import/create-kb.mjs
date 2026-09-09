#!/usr/bin/env node
// Tworzy bazę wiedzy przez API panelu (admin): POST /kbs (createProject) → czeka na create_kb →
// PATCH routingKeywords/piiPolicy → opcjonalnie podnosi drafts.limits na czas importu.
// Użycie: node tools/kb-import/create-kb.mjs --spec <plik.json> [--draft-limits 800]
// spec.json: {namespace, name, description, documentTypes:[{name,description}], routingKeywords:[...], piiPolicy}

import { readFileSync } from 'node:fs';
import { PanelClient, expectOk } from './lib/client.mjs';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const spec = JSON.parse(readFileSync(opt('--spec'), 'utf8'));
const draftLimits = opt('--draft-limits') ? Number(opt('--draft-limits')) : null;

const client = await new PanelClient().open();
try {
  console.log(`zalogowano jako ${client.user} do ${client.base}`);
  const existing = expectOk(await client.get('/api/v1/kbs'), 'GET /kbs').items.find((k) => k.namespace === spec.namespace);
  if (existing) {
    console.log(`baza ${spec.namespace} już istnieje (status ${existing.status}) — pomijam tworzenie`);
  } else {
    const res = await client.post('/api/v1/kbs', {
      namespace: spec.namespace,
      name: spec.name,
      description: spec.description ?? '',
      documentTypes: spec.documentTypes ?? [],
      createProject: true,
    });
    const data = expectOk(res, 'POST /kbs');
    console.log(`utworzono ${spec.namespace}; akcja ${data.actionId} (${data.type})`);
    const action = await client.waitAction(data.actionId, { onLog: (lines) => lines.forEach((l) => console.log(`  | ${l}`)) });
    if (action.status !== 'success') throw new Error(`create_kb zakończone statusem ${action.status}`);
  }
  const patch = {};
  if (spec.routingKeywords) patch.routingKeywords = spec.routingKeywords;
  if (spec.piiPolicy) patch.piiPolicy = spec.piiPolicy;
  if (Object.keys(patch).length > 0) {
    expectOk(await client.patch(`/api/v1/kbs/${spec.namespace}`, patch), 'PATCH /kbs');
    console.log(`ustawiono: ${Object.keys(patch).join(', ')}`);
  }
  if (draftLimits !== null) {
    expectOk(await client.put('/api/v1/settings/drafts.limits', { value: { perDay: draftLimits, perSubmitterPerDay: draftLimits } }), 'PUT /settings/drafts.limits');
    console.log(`drafts.limits → ${draftLimits}/dzień (pamiętaj przywrócić po imporcie)`);
  }
  const kb = expectOk(await client.get(`/api/v1/kbs/${spec.namespace}`), 'GET /kbs/:ns');
  console.log(JSON.stringify(kb, null, 2).slice(0, 1500));
} finally {
  await client.close();
}
