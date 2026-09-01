import type { Db } from '../db/open.js';
import { nowIso } from '../db/open.js';
import { AppError } from '../errors.js';

/**
 * Circuit breaker ze stanem w tabeli breakers (współdzielonym między procesami).
 * closed → licznik KOLEJNYCH porażek; próg otwiera breaker na cooldown z backoffem
 * ×2 przy każdym kolejnym otwarciu (cap maxCooldownMs). Po retry_after przechodzi
 * w half_open i przepuszcza JEDNĄ sondę: sukces zamyka, porażka wydłuża cooldown.
 * Auto-recovery: retry_after w half_open jest deadlinem sondy — gdy proces padnie
 * w trakcie, po jego upływie możliwa jest kolejna sonda (żadnego wiecznego open).
 */

export interface BreakerOptions {
  /** Liczba kolejnych porażek otwierająca breaker (default 3). */
  threshold?: number;
  /** Cooldown pierwszego otwarcia w ms (default 60000). */
  baseCooldownMs?: number;
  /** Górny limit cooldownu w ms (default 3600000). */
  maxCooldownMs?: number;
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

  // Faza 1 (transakcyjnie): decyzja, czy przepuścić wywołanie.
  db.transaction(() => {
    const now = Date.now();
    const row = getRow(db, name);
    if (!row) {
      db.prepare("INSERT INTO breakers (name, state, failure_count, updated_at) VALUES (?, 'closed', 0, ?)")
        .run(name, nowIso());
      return;
    }
    if (row.state === 'closed') return;
    const retryAt = row.retry_after ? Date.parse(row.retry_after) : 0;
    if (now < retryAt) {
      // open przed retry_after LUB half_open z sondą w locie → odrzuć bez wywołania.
      throw new AppError('not_ready', `breaker ${name} open`, { retryAfter: row.retry_after });
    }
    // Czas minął → half_open; nowy retry_after = deadline tej jednej sondy.
    db.prepare("UPDATE breakers SET state = 'half_open', retry_after = ?, updated_at = ? WHERE name = ?")
      .run(new Date(now + baseCooldownMs).toISOString(), nowIso(), name);
  }).immediate();

  try {
    const result = await fn();
    recordSuccess(db, name);
    return result;
  } catch (err) {
    recordFailure(db, name, err, threshold, baseCooldownMs, maxCooldownMs);
    throw err;
  }
}

function recordSuccess(db: Db, name: string): void {
  db.transaction(() => {
    db.prepare(
      "UPDATE breakers SET state = 'closed', reason = NULL, failure_count = 0, opened_at = NULL, retry_after = NULL, updated_at = ? WHERE name = ?",
    ).run(nowIso(), name);
  }).immediate();
}

function recordFailure(
  db: Db,
  name: string,
  err: unknown,
  threshold: number,
  baseMs: number,
  maxMs: number,
): void {
  // Reason przycięty — bez ryzyka wciągnięcia dużych payloadów do DB.
  const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  db.transaction(() => {
    const row = getRow(db, name);
    if (!row) return; // wiersz mógł zniknąć (reset) — nic do zapisania
    const failures = row.failure_count + 1;
    const at = nowIso();
    if (row.state === 'closed' && failures < threshold) {
      db.prepare('UPDATE breakers SET failure_count = ?, reason = ?, updated_at = ? WHERE name = ?')
        .run(failures, reason, at, name);
      return;
    }
    if (row.state === 'open') {
      // Spóźniona porażka wywołania sprzed otwarcia — nie wydłużaj cooldownu.
      db.prepare('UPDATE breakers SET failure_count = ?, reason = ?, updated_at = ? WHERE name = ?')
        .run(failures, reason, at, name);
      return;
    }
    // Próg w closed albo porażka sondy half_open → open z backoffem.
    const cd = cooldownMs(failures, threshold, baseMs, maxMs);
    db.prepare(
      "UPDATE breakers SET state = 'open', failure_count = ?, reason = ?, opened_at = COALESCE(opened_at, ?), retry_after = ?, updated_at = ? WHERE name = ?",
    ).run(failures, reason, at, new Date(Date.now() + cd).toISOString(), at, name);
  }).immediate();
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
