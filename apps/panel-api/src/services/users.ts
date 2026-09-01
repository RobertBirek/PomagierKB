import { randomUUID } from 'node:crypto';
import { nowIso, type Db } from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import type { Role } from '../types.js';

/**
 * Serwis użytkowników (tabela users z migracji shared):
 * - upsertOidcUser: logowanie OIDC — insert/update po `sub` (email, nazwa i rola
 *   odświeżane z claims; status NIE jest reaktywowany — disabled zostaje disabled);
 * - createServiceUser: konta serwisowe (kind='service') będące tożsamościami
 *   dla kluczy MCP — nie logują się przez OIDC (sub=NULL);
 * - setUserStatus: enable/disable; disable KASKADOWO unieważnia aktywne klucze
 *   API użytkownika i usuwa jego sesje (jedna transakcja IMMEDIATE).
 */

export type UserKind = 'oidc' | 'service';
export type UserStatus = 'active' | 'disabled';

export interface UserRow {
  id: string;
  sub: string | null;
  email: string | null;
  display_name: string;
  kind: UserKind;
  role: Role;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

/** Kształt użytkownika w API (camelCase, bez surowych kolumn). */
export interface UserView {
  id: string;
  sub: string | null;
  email: string | null;
  displayName: string;
  kind: UserKind;
  role: Role;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export function toUserView(row: UserRow): UserView {
  return {
    id: row.id,
    sub: row.sub,
    email: row.email,
    displayName: row.display_name,
    kind: row.kind,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

export function getUserById(db: Db, id: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ?? null;
}

export function listUsers(db: Db): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}

export interface UpsertOidcUserInput {
  sub: string;
  email: string | null;
  displayName: string;
  role: Role;
}

/**
 * Upsert po OIDC sub przy logowaniu/refreshu. Zwraca aktualny wiersz —
 * caller MUSI sprawdzić status (disabled nie dostaje sesji).
 */
export function upsertOidcUser(db: Db, input: UpsertOidcUserInput): UserRow {
  const tx = db.transaction((): UserRow => {
    const now = nowIso();
    const existing = db.prepare('SELECT * FROM users WHERE sub = ?').get(input.sub) as
      | UserRow
      | undefined;
    if (existing !== undefined) {
      db.prepare(
        `UPDATE users SET email = ?, display_name = ?, role = ?, updated_at = ?, last_login_at = ?
         WHERE id = ?`,
      ).run(input.email, input.displayName, input.role, now, now, existing.id);
      return { ...existing, email: input.email, display_name: input.displayName, role: input.role, updated_at: now, last_login_at: now };
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO users (id, sub, email, display_name, kind, role, status, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, 'oidc', ?, 'active', ?, ?, ?)`,
    ).run(id, input.sub, input.email, input.displayName, input.role, now, now, now);
    return getUserById(db, id) as UserRow;
  });
  return tx.immediate();
}

/** Aktualizacja roli cache'owanej w users (degradacja/awans po refreshu tokenu). */
export function updateUserRole(db: Db, id: string, role: Role): void {
  db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, nowIso(), id);
}

export interface CreateServiceUserInput {
  displayName: string;
  /** Rola informacyjna konta serwisowego (uprawnienia MCP wynikają ze scopes klucza). */
  role: Role;
}

export function createServiceUser(db: Db, input: CreateServiceUserInput): UserRow {
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, sub, email, display_name, kind, role, status, created_at, updated_at)
     VALUES (?, NULL, NULL, ?, 'service', ?, 'active', ?, ?)`,
  ).run(id, input.displayName, input.role, now, now);
  return getUserById(db, id) as UserRow;
}

export interface SetUserStatusResult {
  user: UserRow;
  /** Liczba kluczy API unieważnionych kaskadą (tylko przy disable). */
  revokedKeys: number;
  /** Liczba usuniętych sesji użytkownika (tylko przy disable). */
  deletedSessions: number;
}

/**
 * Enable/disable użytkownika. Disable = natychmiastowa utrata dostępu:
 * aktywne klucze API → revoked, sesje → usunięte (jedna transakcja).
 */
export function setUserStatus(db: Db, id: string, status: UserStatus): SetUserStatusResult {
  const tx = db.transaction((): SetUserStatusResult => {
    const row = getUserById(db, id);
    if (row === null) throw new AppError('not_found', `Użytkownik nie istnieje: ${id}`);
    const now = nowIso();
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    let revokedKeys = 0;
    let deletedSessions = 0;
    if (status === 'disabled') {
      revokedKeys = db
        .prepare(
          "UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'",
        )
        .run(now, id).changes;
      deletedSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id).changes;
    }
    return { user: getUserById(db, id) as UserRow, revokedKeys, deletedSessions };
  });
  return tx.immediate();
}
