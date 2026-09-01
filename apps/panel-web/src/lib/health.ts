/**
 * Health cockpit — CZYSTE funkcje (port z docs/design/pipeline-frontend.md §(e)).
 * Sygnały: openspg / mcp / quality / inbox / actions / gaps / breakers (+ inne
 * komponenty z GET /api/v1/status). Testy w test/health.test.ts.
 */

export type HealthStatus = 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN';

const STATUS_RANK: Record<HealthStatus, number> = { OK: 0, UNKNOWN: 1, WARN: 2, FAIL: 3 };

/**
 * Normalizacja surowych statusów (OpenSPG buildera, komponentów, akcji) do
 * czterostanowej skali UI: PASS/FINISH/OK/DONE→OK; FAIL/ERROR/DOWN→FAIL;
 * WARN/RUNNING/STALE/PENDING→WARN; reszta→UNKNOWN.
 */
export function normalizeStatus(raw: string | null | undefined): HealthStatus {
  if (raw === null || raw === undefined) return 'UNKNOWN';
  switch (raw.trim().toUpperCase()) {
    case 'OK':
    case 'PASS':
    case 'PASSED':
    case 'FINISH':
    case 'FINISHED':
    case 'DONE':
    case 'SUCCESS':
    case 'ACTIVE':
    case 'HEALTHY':
      return 'OK';
    case 'FAIL':
    case 'FAILED':
    case 'ERROR':
    case 'DOWN':
    case 'TERMINATE':
    case 'TERMINATED':
      return 'FAIL';
    case 'WARN':
    case 'WARNING':
    case 'RUNNING':
    case 'STALE':
    case 'PENDING':
    case 'DEGRADED':
      return 'WARN';
    default:
      return 'UNKNOWN';
  }
}

/** Najgorszy status z listy (FAIL > WARN > UNKNOWN > OK); pusta lista → UNKNOWN. */
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.length === 0) return 'UNKNOWN';
  let worst: HealthStatus = 'OK';
  // UNKNOWN na wejściu nie może „poprawić" wyniku — startujemy od OK i tylko pogarszamy.
  for (const s of statuses) if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  return worst;
}

export interface HealthSignal {
  id: string;
  /** Klucz etykiety w pl.ts (np. 'health.signal.openspg') LUB gotowa etykieta z API. */
  label: string;
  /** Krótki opis wartości (PL, do tooltipa / listy szczegółów). */
  value: string;
  status: HealthStatus;
}

/** Kształt danych z GET /api/v1/status (services/status.ts panel-api). */
export interface StatusComponentInput {
  id: string;
  label: string;
  status: string; // 'ok' | 'warn' | 'down' | 'unknown'
  detail?: string;
}

export interface HealthCockpitInput {
  components?: readonly StatusComponentInput[];
  /** Breakery LLM — otwarty breaker to WARN. */
  breakers?: readonly { name: string; state: string }[];
  /** Liczniki domenowe (opcjonalne — sekcje API powstają równolegle). */
  pendingDrafts?: number;
  failedActions?: number;
  runningActions?: number;
  openGaps?: number;
  gapsWarnThreshold?: number;
  /** Werdykty quality gate aktywnych KB ('OK'|'WARN'|'FAIL'). */
  qualityVerdicts?: readonly string[];
}

export interface HealthCockpit {
  overallStatus: HealthStatus;
  signals: HealthSignal[];
}

const OPEN_BREAKER_STATES = new Set(['open', 'half-open', 'half_open']);

/**
 * Buduje cockpit zdrowia: komponenty statusu + sygnały domenowe.
 * Reguły: pending draftów>0 → WARN (czeka recenzja); akcje failed → FAIL,
 * running → WARN; luki > próg → WARN; otwarty breaker → WARN;
 * quality = najgorszy verdict aktywnych KB.
 */
export function buildHealthCockpit(input: HealthCockpitInput): HealthCockpit {
  const signals: HealthSignal[] = [];

  for (const c of input.components ?? []) {
    const status = normalizeStatus(c.status === 'down' ? 'DOWN' : c.status);
    signals.push({ id: c.id, label: c.label, value: c.detail ?? '', status });
  }

  if (input.qualityVerdicts !== undefined && input.qualityVerdicts.length > 0) {
    const st = worstStatus(input.qualityVerdicts.map(normalizeStatus));
    signals.push({ id: 'quality', label: 'health.signal.quality', value: '', status: st });
  }

  if (input.pendingDrafts !== undefined) {
    signals.push({
      id: 'inbox',
      label: 'health.signal.inbox',
      value: String(input.pendingDrafts),
      status: input.pendingDrafts > 0 ? 'WARN' : 'OK',
    });
  }

  if (input.failedActions !== undefined || input.runningActions !== undefined) {
    const failed = input.failedActions ?? 0;
    const running = input.runningActions ?? 0;
    signals.push({
      id: 'actions',
      label: 'health.signal.actions',
      value: `${failed}/${running}`,
      status: failed > 0 ? 'FAIL' : running > 0 ? 'WARN' : 'OK',
    });
  }

  if (input.openGaps !== undefined) {
    const threshold = input.gapsWarnThreshold ?? 10;
    signals.push({
      id: 'gaps',
      label: 'health.signal.gaps',
      value: String(input.openGaps),
      status: input.openGaps > threshold ? 'WARN' : 'OK',
    });
  }

  if (input.breakers !== undefined) {
    const open = input.breakers.filter((b) => OPEN_BREAKER_STATES.has(b.state.toLowerCase()));
    signals.push({
      id: 'breakers',
      label: 'health.signal.breakers',
      value: String(open.length),
      status: open.length > 0 ? 'WARN' : 'OK',
    });
  }

  return { overallStatus: worstStatus(signals.map((s) => s.status)), signals };
}
