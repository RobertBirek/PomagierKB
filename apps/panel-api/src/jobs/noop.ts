import { setTimeout as sleep } from 'node:timers/promises';
import { JobFailure, type JobContext } from './job-types.js';

/**
 * Job testowy 'noop' — do testów E2E runnera (spawn → progress → status).
 * Trzy kroki progress; konfigurowalny przez params:
 * - sleepMs   (number, domyślnie 25)  — pauza po każdym kroku;
 * - exitCode  (number, domyślnie 0)   — ≠0 → JobFailure z tym kodem (status=error).
 */
export default async function noop(ctx: JobContext): Promise<void> {
  const sleepMs = toNumber(ctx.params['sleepMs'], 25);
  const exitCode = toNumber(ctx.params['exitCode'], 0);

  const phases = ['przygotowanie', 'praca', 'domykanie'] as const;
  for (let i = 0; i < phases.length; i++) {
    ctx.progress({
      phase: phases[i] as string,
      current: i + 1,
      total: phases.length,
      message: `noop: ${phases[i] as string}`,
    });
    await sleep(sleepMs);
  }

  if (exitCode !== 0) {
    throw new JobFailure(`noop: wymuszony błąd (exitCode=${exitCode})`, exitCode);
  }
  ctx.log('noop: wszystkie kroki wykonane');
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value !== null ? n : fallback;
}
