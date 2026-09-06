import type { Db } from '../db/open.js';
import { nowIso } from '../db/open.js';
import { appendAudit } from '../audit/append.js';
import { AppError } from '../errors.js';
import { recordUsageFromResult } from './usage.js';

/**
 * Circuit breaker ze stanem w tabeli breakers (współdzielonym między procesami).
 * closed → licznik KOLEJNYCH porażek; próg otwiera breaker na cooldown z backoffem
 * ×2 przy każdym kolejnym otwarciu (cap maxCooldownMs). Po retry_after przechodzi
 * w half_open i przepuszcza JEDNĄ sondę: sukces zamyka, porażka wydłuża cooldown.
 * Auto-recovery: retry_after w half_open jest deadlinem sondy — gdy proces padnie
 * w trakcie, po jego upływie możliwa jest kolejna sonda (żadnego wiecznego open).
 *
 * ŚLAD INCYDENTU (ustalenie D10-05): samonaprawa kasowała jedyny zapis o awarii
 * (recordSuccess zeruje reason/opened_at), więc po nocnej awarii LLM operator nie
 * miał ŻADNEJ informacji, że była. Każde przejście stanu jest teraz audytowane
 * (breaker.open / breaker.half_open / breaker.close) i logowane. Telemetria leci
 * PO commicie transakcji breakera i jest owinięta try/catch — nie może zepsuć
 * auto-recovery ani zablokować wywołania.
 */

export interface BreakerOptions {
  /** Liczba kolejnych porażek otwierająca breaker (default 3). */
  threshold?: number;
  /** Cooldown pierwszego otwarcia w ms (default 60000). */
  baseCooldownMs?: number;
  /** Górny limit cooldownu w ms (default 3600000). */
  maxCooldownMs?: number;
  /** Log przejść stanu (np. app.log.warn) — audyt leci niezależnie. */
  logger?: (event: BreakerTransition) => void;
}

/** Zdarzenie przejścia stanu breakera (audyt + log). */
export interface BreakerTransition {
  name: string;
  from: 'closed' | 'open' | 'half_open';
  to: 'closed' | 'open' | 'half_open';
  reason: string | null;
  failureCount: number;
  /** Długość cooldownu nadanego przy otwarciu (ms). */
  cooldownMs?: number;
  openedAt?: string | null;
  /** Czas trwania incydentu przy zamknięciu (ms od opened_at). */
  durationMs?: number | null;
}

export interface BreakerState {
  name: string;
  state: 'closed' | 'open' | 'half_open';
  reason: string | null;
  failureCount: number;
  openedAt: string | null;
  retryAfter: string | null;
  updatedAt: string;
}

interface BreakerRow {
  name: string;
  state: 'closed' | 'open' | 'half_open';
  reason: string | null;
  failure_count: number;
  opened_at: string | null;
  retry_after: string | null;
  updated_at: string;
}

function getRow(db: Db, name: string): BreakerRow | undefined {
  return db
    .prepare('SELECT name, state, reason, failure_count, opened_at, retry_after, updated_at FROM breakers WHERE name = ?')
    .get(name) as BreakerRow | undefined;
}

/** Cooldown wyprowadzony z licznika porażek: próg → base, każda kolejna porażka ×2, cap max. */
function cooldownMs(failureCount: number, threshold: number, baseMs: number, maxMs: number): number {
  const doublings = Math.min(30, Math.max(0, failureCount - threshold));
  return Math.min(maxMs, baseMs * 2 ** doublings);
}

/**
 * Wykonuje fn pod ochroną breakera `name`. Gdy breaker jest otwarty i nie minął
 * retry_after — rzuca AppError('not_ready') BEZ wywołania fn. Błąd fn jest
 * propagowany bez zmian (breaker tylko rejestruje porażkę).
 */
export async function withBreaker<T>(
  db: Db,
  name: string,
  fn: () => Promise<T>,
  opts: BreakerOptions = {},
): Promise<T> {
  const threshold = opts.threshold ?? 3;
  const baseCooldownMs = opts.baseCooldownMs ?? 60_000;
  const maxCooldownMs = opts.maxCooldownMs ?? 3_600_000;

  // Faza 1: decyzja, czy przepuścić wywołanie.
  //
  // D8-10: szybka ścieżka BEZ transakcji. Breaker w stanie 'closed' nie ma czego
  // zapisać przy wpuszczeniu wywołania, a `BEGIN IMMEDIATE` brał wyłączny lock
  // pisarza SQLite przy KAŻDYM wyszukiwaniu i puchł WAL. Zapis (INSERT wiersza,
  // przejście open→half_open) nadal idzie transakcyjnie i re-czyta wiersz w środku,
  // więc wyścig dwóch procesów rozstrzyga się tak samo jak dotąd.
  const fastRow = getRow(db, name);
  const admitTransition =
    fastRow !== undefined && fastRow.state === 'closed'
      ? null
      : admitTransactionally(db, name, baseCooldownMs);
  emitTransition(db, admitTransition, opts.logger);

  try {
    const result = await fn();
    recordSuccess(db, name, opts.logger);
    // Telemetria kosztu (GAP-05): withBreaker to JEDYNY punkt, przez który
    // przechodzą wszystkie wywołania LLM — stąd rejestr tokenów per model.
    if (name.startsWith('llm.')) {
      try {
        recordUsageFromResult(db, name, result);
      } catch {
        /* best-effort */
      }
    }
    return result;
  } catch (err) {
    recordFailure(db, name, err, threshold, baseCooldownMs, maxCooldownMs, opts.logger);
    throw err;
  }
}

/** Wpuszczenie wymagające zapisu: brak wiersza albo breaker poza stanem 'closed'. */
function admitTransactionally(db: Db, name: string, baseCooldownMs: number): BreakerTransition | null {
  return db.transaction((): BreakerTransition | null => {
    const now = Date.now();
    const row = getRow(db, name);
    if (!row) {
      db.prepare("INSERT INTO breakers (name, state, failure_count, updated_at) VALUES (?, 'closed', 0, ?)")
        .run(name, nowIso());
      return null;
    }
    if (row.state === 'closed') return null;
    const retryAt = row.retry_after ? Date.parse(row.retry_after) : 0;
    if (now < retryAt) {
      // open przed retry_after LUB half_open z sondą w locie → odrzuć bez wywołania.
      throw new AppError('not_ready', `breaker ${name} open`, { retryAfter: row.retry_after });
    }
    // Czas minął → half_open; nowy retry_after = deadline tej jednej sondy.
    db.prepare("UPDATE breakers SET state = 'half_open', retry_after = ?, updated_at = ? WHERE name = ?")
      .run(new Date(now + baseCooldownMs).toISOString(), nowIso(), name);
    return {
      name,
      from: row.state,
      to: 'half_open',
      reason: row.reason,
      failureCount: row.failure_count,
      openedAt: row.opened_at,
    };
  }).immediate();
}

/**
 * Audyt + log przejścia — PO commicie transakcji breakera (appendAudit otwiera
 * własne BEGIN IMMEDIATE, więc nie może biec w transakcji wołającego) i w
 * try/catch: awaria zapisu telemetrii nie może zatrzymać auto-recovery.
 */
function emitTransition(
  db: Db,
  transition: BreakerTransition | null,
  logger?: (event: BreakerTransition) => void,
): void {
  if (transition === null) return;
  try {
    logger?.(transition);
  } catch {
    /* logger nie może wywrócić breakera */
  }
  const action =
    transition.to === 'open' ? 'breaker.open' : transition.to === 'closed' ? 'breaker.close' : 'breaker.half_open';
  try {
    appendAudit(db, {
      actor: 'system',
      actorType: 'system',
      action,
      resourceType: 'breaker',
      resourceId: transition.name,
      before: { state: transition.from },
      after: { state: transition.to },
      metadata: {
        reason: transition.reason,
        failureCount: transition.failureCount,
        ...(transition.cooldownMs !== undefined ? { cooldownMs: transition.cooldownMs } : {}),
        ...(transition.openedAt !== undefined ? { openedAt: transition.openedAt } : {}),
        ...(transition.durationMs !== undefined && transition.durationMs !== null
          ? { durationMs: transition.durationMs }
          : {}),
      },
    });
  } catch {
    /* audyt best-effort — incydent i tak jest w logu */
  }
}

/** Wiersz w stanie spoczynku: nic do zapisania po udanym wywołaniu. */
function isPristine(row: BreakerRow | undefined): boolean {
  return (
    row !== undefined &&
    row.state === 'closed' &&
    row.failure_count === 0 &&
    row.reason === null &&
    row.opened_at === null &&
    row.retry_after === null
  );
}

function recordSuccess(db: Db, name: string, logger?: (event: BreakerTransition) => void): void {
  // D8-10: zdrowy breaker po udanym wywołaniu zapisywał `updated_at` w transakcji
  // IMMEDIATE przy KAŻDYM wyszukiwaniu — czysta rywalizacja o lock i wzrost WAL.
  // Zapisujemy tylko wtedy, gdy stan albo licznik faktycznie się zmienia;
  // `updated_at` znaczy odtąd „ostatnia ZMIANA stanu”, nie „ostatnie wywołanie”.
  if (isPristine(getRow(db, name))) return;
  const transition = db.transaction((): BreakerTransition | null => {
    const row = getRow(db, name);
    db.prepare(
      "UPDATE breakers SET state = 'closed', reason = NULL, failure_count = 0, opened_at = NULL, retry_after = NULL, updated_at = ? WHERE name = ?",
    ).run(nowIso(), name);
    // Ślad zostawiamy TYLKO przy realnym powrocie do zdrowia (open/half_open →
    // closed); zwykły sukces przy zamkniętym breakerze nie generuje zdarzeń.
    if (!row || row.state === 'closed') return null;
    const openedAtMs = row.opened_at !== null ? Date.parse(row.opened_at) : NaN;
    return {
      name,
      from: row.state,
      to: 'closed',
      reason: row.reason,
      failureCount: row.failure_count,
      openedAt: row.opened_at,
      durationMs: Number.isFinite(openedAtMs) ? Date.now() - openedAtMs : null,
    };
  }).immediate();
  emitTransition(db, transition, logger);
}

function recordFailure(
  db: Db,
  name: string,
  err: unknown,
  threshold: number,
  baseMs: number,
  maxMs: number,
  logger?: (event: BreakerTransition) => void,
): void {
  // Reason przycięty — bez ryzyka wciągnięcia dużych payloadów do DB.
  const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  const transition = db.transaction((): BreakerTransition | null => {
    const row = getRow(db, name);
    if (!row) return null; // wiersz mógł zniknąć (reset) — nic do zapisania
    const failures = row.failure_count + 1;
    const at = nowIso();
    if (row.state === 'closed' && failures < threshold) {
      db.prepare('UPDATE breakers SET failure_count = ?, reason = ?, updated_at = ? WHERE name = ?')
        .run(failures, reason, at, name);
      return null;
    }
    if (row.state === 'open') {
      // Spóźniona porażka wywołania sprzed otwarcia — nie wydłużaj cooldownu.
      db.prepare('UPDATE breakers SET failure_count = ?, reason = ?, updated_at = ? WHERE name = ?')
        .run(failures, reason, at, name);
      return null;
    }
    // Próg w closed albo porażka sondy half_open → open z backoffem.
    const cd = cooldownMs(failures, threshold, baseMs, maxMs);
    db.prepare(
      "UPDATE breakers SET state = 'open', failure_count = ?, reason = ?, opened_at = COALESCE(opened_at, ?), retry_after = ?, updated_at = ? WHERE name = ?",
    ).run(failures, reason, at, new Date(Date.now() + cd).toISOString(), at, name);
    return {
      name,
      from: row.state,
      to: 'open',
      reason,
      failureCount: failures,
      cooldownMs: cd,
      openedAt: row.opened_at ?? at,
    };
  }).immediate();
  emitTransition(db, transition, logger);
}

/** Stany wszystkich breakerów — do cockpitu /api/v1/status. */
export function getBreakerStates(db: Db): BreakerState[] {
  const rows = db
    .prepare('SELECT name, state, reason, failure_count, opened_at, retry_after, updated_at FROM breakers ORDER BY name')
    .all() as BreakerRow[];
  return rows.map((r) => ({
    name: r.name,
    state: r.state,
    reason: r.reason,
    failureCount: r.failure_count,
    openedAt: r.opened_at,
    retryAfter: r.retry_after,
    updatedAt: r.updated_at,
  }));
}

/** Ręczne zamknięcie breakera (przycisk „wznów teraz”). Zwraca false, gdy brak wiersza. */
export function resetBreaker(db: Db, name: string): boolean {
  const info = db
    .prepare(
      "UPDATE breakers SET state = 'closed', reason = NULL, failure_count = 0, opened_at = NULL, retry_after = NULL, updated_at = ? WHERE name = ?",
    )
    .run(nowIso(), name);
  return info.changes > 0;
}
