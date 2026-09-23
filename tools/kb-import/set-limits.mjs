#!/usr/bin/env node
// Ustawia limity dzienne szkiców (settings 'drafts.limits') przez API panelu — na czas importu
// masowego podnieś (1500 1500), po nim PRZYWRÓĆ (100 25). Sesja: kag-e2e (tools/ux-audit/lib/session.mjs).
// Użycie: node tools/kb-import/set-limits.mjs <perDay> <perSubmitterPerDay>
import { PanelClient } from './lib/client.mjs';
const [perDay, perSub] = process.argv.slice(2).map(Number);
if (!Number.isInteger(perDay) || !Number.isInteger(perSub)) { console.error('użycie: set-limits.mjs <perDay> <perSubmitterPerDay>'); process.exit(2); }
const client = await new PanelClient().open();
try {
  const r = await client.put('/api/v1/settings/drafts.limits', { value: { perDay, perSubmitterPerDay: perSub } });
  console.log(`drafts.limits → ${perDay}/${perSub}: HTTP ${r.status}${r.body?.ok ? '' : ' ' + JSON.stringify(r.body?.error)}`);
  process.exit(r.body?.ok ? 0 : 1);
} finally { await client.close(); }
