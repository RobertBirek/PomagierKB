/**
 * Słownik komunikatów statusów: mapowanie surowych stanów technicznych
 * (statusy KB, draftów, akcji, komponentów, builder joba OpenSPG) na wariant
 * plakietki i POLSKĄ etykietę z perspektywy człowieka (soczewka product:
 * „statusy z perspektywy dokumentu i człowieka, nie joba").
 * Czyste funkcje — testy w test/status.test.ts.
 */
import { pl, type PlKey } from '../i18n/pl';
import { normalizeStatus, type HealthStatus } from './health';

export type BadgeVariant = 'ok' | 'warn' | 'fail' | 'neutral' | 'accent';

/** Surowy status → wariant kolorystyczny plakietki. */
const VARIANT_BY_RAW: Record<string, BadgeVariant> = {
  // komponenty / health
  ok: 'ok',
  warn: 'warn',
  down: 'fail',
  unknown: 'neutral',
  // akcje 202+actionId
  running: 'accent',
  pending: 'neutral',
  done: 'ok',
  failed: 'fail',
  canceled: 'neutral',
  // KB registry
  active: 'ok',
  draft: 'neutral',
  archived: 'neutral',
  // drafty inboxu
  promoted: 'ok',
  rejected: 'fail',
  // builder job OpenSPG
  finish: 'ok',
  error: 'fail',
  terminate: 'fail',
};

export function statusVariant(raw: string | null | undefined): BadgeVariant {
  if (raw === null || raw === undefined) return 'neutral';
  const direct = VARIANT_BY_RAW[raw.trim().toLowerCase()];
  if (direct !== undefined) return direct;
  const normalized: HealthStatus = normalizeStatus(raw);
  return normalized === 'OK' ? 'ok' : normalized === 'FAIL' ? 'fail' : normalized === 'WARN' ? 'warn' : 'neutral';
}

/** Surowy status → klucz etykiety PL w pl.ts. */
const LABEL_KEY_BY_RAW: Record<string, PlKey> = {
  ok: 'status.ok',
  warn: 'status.warn',
  down: 'status.down',
  unknown: 'status.unknown',
  running: 'status.running',
  pending: 'status.pending',
  done: 'status.done',
  failed: 'status.failed',
  canceled: 'status.canceled',
  active: 'status.active',
  draft: 'status.draft',
  archived: 'status.archived',
  promoted: 'status.promoted',
  rejected: 'status.rejected',
  finish: 'status.done',
  error: 'status.failed',
  terminate: 'status.canceled',
  fail: 'status.fail',
};

/**
 * Polska etykieta statusu. Nieznany status NIE wycieka po angielsku —
 * wraca etykieta znormalizowanego stanu (OK/Ostrzeżenie/Błąd/Nieznany).
 */
export function statusLabel(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return pl['status.unknown'];
  const key = LABEL_KEY_BY_RAW[raw.trim().toLowerCase()];
  if (key !== undefined) return pl[key];
  const normalized = normalizeStatus(raw);
  const fallbackKey: PlKey =
    normalized === 'OK'
      ? 'status.ok'
      : normalized === 'FAIL'
        ? 'status.fail'
        : normalized === 'WARN'
          ? 'status.warn'
          : 'status.unknown';
  return pl[fallbackKey];
}

/** HealthStatus (cockpit) → wariant plakietki. */
export function healthVariant(status: HealthStatus): BadgeVariant {
  return status === 'OK' ? 'ok' : status === 'FAIL' ? 'fail' : status === 'WARN' ? 'warn' : 'neutral';
}
