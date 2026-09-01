import { createHash, randomBytes } from 'node:crypto';
import { nowIso, type Db } from '@pomagierkb/shared/db';
import type { Role } from '../types.js';

/**
 * Magazyn sesji w SQLite (tabela sessions z migracji shared 0001_init):
 * - w cookie kag_sid jest surowy sid (256 bitów base64url), w DB WYŁĄCZNIE
 *   sha256(sid) — kradzież pliku bazy nie daje przejęcia sesji;
 * - TTL absolutny 12 h + idle 60 min (sliding; zapis idle najwyżej co 60 s);
 * - sweepExpired() woła server.ts co 15 min (i hook sesji przy trafieniu
 *   na wygasły wiersz).
 */

export const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60_000;
export const SESSION_IDLE_TTL_MS = 60 * 60_000;
/** Sliding idle zapisywany do DB najwyżej raz na tyle ms (mniej zapisów WAL). */
export const SESSION_IDLE_WRITE_EVERY_MS = 60_000;

/** 256-bit losowy identyfikator sesji (wartość cookie kag_sid). */
export function generateSid(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 hex sid — klucz wiersza sessions.id_hash i rate-limitu per sesja. */
export function hashSid(sid: string): string {
  return createHash('sha256').update(sid, 'utf8').digest('hex');
}

/** Wiersz sesji złączony z użytkownikiem (jedno zapytanie na żądanie). */
export interface SessionWithUser {
  idHash: string;
  userId: string;
  /** Snapshot roli z momentu logowania/ostatniego refreshu tokenu. */
  role: Role;
  tokensEnc: string | null;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  email: string | null;
  displayName: string;
  userStatus: 'active' | 'disabled';
}

interface JoinedRow {
  id_hash: string;
  user_id: string;
  role: Role;
  tokens_enc: string | null;
  absolute_expires_at: string;
  idle_expires_at: string;
  email: string | null;
  display_name: string;
  user_status: 'active' | 'disabled';
}

function toSession(row: JoinedRow): SessionWithUser {
  return {
    idHash: row.id_hash,
    userId: row.user_id,
    role: row.role,
    tokensEnc: row.tokens_enc,
    absoluteExpiresAt: row.absolute_expires_at,
    idleExpiresAt: row.idle_expires_at,
    email: row.email,
    displayName: row.display_name,
    userStatus: row.user_status,
  };
}

export interface CreateSessionInput {
  userId: string;
  role: Role;
  /** Zsealowane tokeny IdP (plugins/oidc.ts sealTokens) lub null. */
  tokensEnc: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** Tworzy sesję; zwraca surowy sid (do cookie) i jego hash (do req.user.sessionHash). */
export function createSession(db: Db, input: CreateSessionInput): { sid: string; sidHash: string } {
  const sid = generateSid();
  const sidHash = hashSid(sid);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id_hash, user_id, role, tokens_enc, ip, user_agent,
       created_at, absolute_expires_at, idle_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sidHash,
    input.userId,
    input.role,
    input.tokensEnc,
    input.ip,
    input.userAgent,
    new Date(now).toISOString(),
    new Date(now + SESSION_ABSOLUTE_TTL_MS).toISOString(),
    new Date(now + SESSION_IDLE_TTL_MS).toISOString(),
  );
  return { sid, sidHash };
}

/** Sesja + użytkownik po hashu sid; null gdy wiersz nie istnieje. */
export function getSessionWithUser(db: Db, idHash: string): SessionWithUser | null {
  const row = db
    .prepare(
      `SELECT s.id_hash, s.user_id, s.role, s.tokens_enc, s.absolute_expires_at,
              s.idle_expires_at, u.email, u.display_name, u.status AS user_status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ?`,
    )
    .get(idHash) as JoinedRow | undefined;
  return row === undefined ? null : toSession(row);
}

/**
 * Sliding idle: przesuwa idle_expires_at na now+60min, ale zapisuje tylko gdy
 * poprzednia wartość jest starsza o ≥60 s (warunek w WHERE — zero zapisu
 * przy każdym żądaniu).
 */
export function touchIdle(db: Db, idHash: string, now = new Date()): void {
  const nextIdle = new Date(now.getTime() + SESSION_IDLE_TTL_MS).toISOString();
  const writeThreshold = new Date(
    now.getTime() + SESSION_IDLE_TTL_MS - SESSION_IDLE_WRITE_EVERY_MS,
  ).toISOString();
  db.prepare('UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ? AND idle_expires_at < ?').run(
    nextIdle,
    idHash,
    writeThreshold,
  );
}

/** Po udanym refreshu tokenu: nowe tokeny + snapshot roli (degradacja/awans wg grup). */
export function updateSessionAuth(
  db: Db,
  idHash: string,
  input: { tokensEnc: string; role: Role },
): void {
  db.prepare('UPDATE sessions SET tokens_enc = ?, role = ? WHERE id_hash = ?').run(
    input.tokensEnc,
    input.role,
    idHash,
  );
}

export function deleteSession(db: Db, idHash: string): void {
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
}

/** Usuwa wygasłe sesje (absolutny LUB idle TTL); zwraca liczbę usuniętych. */
export function sweepExpired(db: Db, now = nowIso()): number {
  return db
    .prepare('DELETE FROM sessions WHERE absolute_expires_at <= ? OR idle_expires_at <= ?')
    .run(now, now).changes;
}
