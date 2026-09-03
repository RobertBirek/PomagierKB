/**
 * Czysta logika widoku akcji (bez Reacta/DOM — testy w test/actions-core.test.ts,
 * importy RELATYWNE, bo root vitest.config.ts nie zna aliasu '@').
 * - słownik znanych typów akcji (rejestr jobów panel-api) + mapowanie filtra
 *   typu na stan pary Select/Input („inny…" z polem tekstowym),
 * - procent/etap z progress_json (lustro components/ActionProgress.tsx),
 * - wariant Badge dla statusu akcji.
 */

/**
 * Znane typy akcji — zweryfikowane w apps/panel-api:
 * jobs/run-job.ts (JOB_MODULES: noop, build_kb, quality_gate) oraz
 * routes/kbs.ts (create_kb, schema_sync, build_kb, quality_gate).
 */
export const KNOWN_ACTION_TYPES = [
  'build_kb',
  'create_kb',
  'schema_sync',
  'quality_gate',
  'noop',
] as const;

/** Wartość opcji „inny…" w Selectcie typu (nigdy nie trafia do URL-a). */
export const OTHER_ACTION_TYPE = '__other__';

export interface TypeFilterState {
  /** Wartość Selecta: '' (wszystkie), znany typ albo OTHER_ACTION_TYPE. */
  select: string;
  /** Wartość Inputa fallback (tylko gdy select === OTHER_ACTION_TYPE). */
  custom: string;
}

/**
 * Mapuje filtr typu z URL-a na stan pary kontrolek Select+Input:
 * pusty → wszystkie; znany typ → opcja słownikowa; nieznany → „inny…" + Input.
 */
export function typeFilterFromUrl(type: string): TypeFilterState {
  const trimmed = type.trim();
  if (trimmed === '') return { select: '', custom: '' };
  if ((KNOWN_ACTION_TYPES as readonly string[]).includes(trimmed)) {
    return { select: trimmed, custom: '' };
  }
  return { select: OTHER_ACTION_TYPE, custom: trimmed };
}

/**
 * Procent postępu z progress_json akcji: pole percent wprost albo
 * current/total; brak danych → null (pasek indeterminate przy running).
 * Lustro progressPercent z components/ActionProgress.tsx.
 */
export function actionProgressPercent(progress: Record<string, unknown> | null): number | null {
  if (progress === null) return null;
  const percent = progress['percent'];
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    return Math.max(0, Math.min(100, percent));
  }
  const current = progress['current'];
  const total = progress['total'];
  if (typeof current === 'number' && typeof total === 'number' && total > 0) {
    return Math.max(0, Math.min(100, (current / total) * 100));
  }
  return null;
}

/** Etykieta etapu z progress_json (stepLabel/message/step/stage) albo null. */
export function actionProgressStep(progress: Record<string, unknown> | null): string | null {
  if (progress === null) return null;
  for (const key of ['stepLabel', 'message', 'step', 'stage']) {
    const value = progress[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

export type ActionBadgeVariant = 'ok' | 'warn' | 'fail' | 'info' | 'neutral';

/** Wariant Badge dla statusu akcji (running/success/error/cancelled). */
export function actionStatusVariant(status: string): ActionBadgeVariant {
  switch (status) {
    case 'running':
      return 'info';
    case 'success':
      return 'ok';
    case 'error':
      return 'fail';
    case 'cancelled':
      return 'warn';
    default:
      return 'neutral';
  }
}
