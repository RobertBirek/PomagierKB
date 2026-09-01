import type { OpenSpgClient } from '@pomagierkb/shared/openspg';
import { loadConfig } from '../config.js';
import { makeOpenSpgClient } from '../services/kb.js';
import { humanize } from '../services/messages.js';
import { runQualityGate } from '../pipeline/quality-gate.js';
import { JobFailure, type JobFn } from './job-types.js';

/**
 * Akcja quality_gate (Etap 9) — kontrola jakości NA ŻĄDANIE
 * (POST /api/v1/kbs/:ns/quality → 202): uruchamia 10 checków na ostatnim
 * eksporcie KB i zapisuje raport do quality_reports. Werdykt FAIL NIE wywraca
 * akcji — raport jest artefaktem (widoczny w GET /kbs/:ns/quality); akcja
 * kończy się błędem tylko gdy checków nie dało się policzyć.
 * Bez konfiguracji OpenSPG w env check live_search_sanity jest pomijany.
 */
const runQualityGateJob: JobFn = async (ctx) => {
  const namespace = typeof ctx.params['namespace'] === 'string' ? ctx.params['namespace'] : '';
  if (namespace === '') throw new JobFailure('akcja quality_gate wymaga parametru namespace', 2);

  let client: OpenSpgClient | null = null;
  try {
    client = makeOpenSpgClient({ ...loadConfig(process.env), dataDir: ctx.dataDir });
  } catch {
    ctx.log('niepełna konfiguracja środowiska — live_search_sanity zostanie pominięty');
  }

  ctx.progress({ phase: 'quality', current: 1, total: 1, message: 'Kontrola jakości eksportu i grafu' });
  const report = await runQualityGate({ db: ctx.db, namespace, client, log: (msg) => ctx.log(msg) });
  const failed = report.checks.filter((c) => !c.ok).length;
  ctx.log(`quality gate: ${report.verdict} (${humanize(report.verdict).label}; nieudanych checków: ${failed})`);
};

export default runQualityGateJob;
