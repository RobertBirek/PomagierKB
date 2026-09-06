import { createHash, randomUUID } from 'node:crypto';
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
 *   API użytkownika i usuwa jego sesje (jedna transakcja IMMEDIATE) — z blokadą
 *   samowyłączenia i wyłączenia ostatniego administratora (audyt D3-04);
 * - anonymizeUser: realizacja prawa do usunięcia danych (audyt D14-04) — czyści
 *   e-mail/nazwę i zastępuje `sub` skrótem, zachowując UUID pod klucze obce.
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

/**
 * Liczba aktywnych administratorów mogących się zalogować. Konta serwisowe nie
 * logują się przez OIDC (sub=NULL) i nie mogą mieć roli admin, więc jedynym
 * zabezpieczeniem przed trwałym lockoutem panelu jest ten licznik.
 */
export function countActiveOidcAdmins(db: Db): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM users WHERE kind = 'oidc' AND role = 'admin' AND status = 'active'",
    )
    .get() as { c: number };
  return row.c;
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

export interface SetUserStatusOptions {
  /** users.id administratora wykonującego zmianę — blokuje samowyłączenie. */
  actorId?: string;
}

/**
 * Enable/disable użytkownika. Disable = natychmiastowa utrata dostępu:
 * aktywne klucze API → revoked, sesje → usunięte (jedna transakcja).
 *
 * Dwie blokady 409 (audyt D3-04) sprawdzane WEWNĄTRZ transakcji IMMEDIATE, żeby
 * dwie równoległe zmiany nie wyłączyły ostatnich dwóch adminów naraz:
 * - nie można wyłączyć własnego konta (natychmiastowe usunięcie własnej sesji),
 * - nie można wyłączyć ostatniego aktywnego administratora OIDC — status nie jest
 *   reaktywowany przy logowaniu, więc byłby to trwały lockout panelu bez ścieżki
 *   odzyskania inaczej niż ręcznym UPDATE w SQLite.
 */
export function setUserStatus(
  db: Db,
  id: string,
  status: UserStatus,
  opts: SetUserStatusOptions = {},
): SetUserStatusResult {
  const tx = db.transaction((): SetUserStatusResult => {
    const row = getUserById(db, id);
    if (row === null) throw new AppError('not_found', `Użytkownik nie istnieje: ${id}`);
    if (status === 'disabled' && row.status === 'active') {
      if (opts.actorId !== undefined && opts.actorId === id) {
        throw new AppError(
          'conflict',
          'Nie można wyłączyć własnego konta — poproś innego administratora',
        );
      }
      if (row.kind === 'oidc' && row.role === 'admin' && countActiveOidcAdmins(db) <= 1) {
        throw new AppError(
          'conflict',
          'To ostatni aktywny administrator — wyłączenie zablokowałoby dostęp do panelu',
        );
      }
    }
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

/** Nazwa zastępcza po anonimizacji (display_name jest NOT NULL). */
export const ANONYMIZED_DISPLAY_NAME = '[użytkownik usunięty]';

export interface AnonymizeUserResult {
  user: UserRow;
  revokedKeys: number;
  deletedSessions: number;
  /** Liczba wierszy answers, którym odpięto user_id (pytania bywają osobowe). */
  detachedAnswers: number;
}

/**
 * Anonimizacja konta po offboardingu (audyt D14-04, art. 17 RODO):
 * e-mail → NULL, nazwa → placeholder, `sub` → sha256 (zachowuje UNIQUE i sprawia,
 * że ponowne logowanie tej samej osoby w Authentiku utworzy NOWE konto zamiast
 * wskrzesić stare), sesje usunięte, klucze API unieważnione, answers.user_id
 * odpięte. users.id (UUID) ZOSTAJE — jest pseudonimem trzymającym klucze obce
 * audytu, drafts.submitted_by_user/decided_by i intakes.created_by.
 *
 * Wymaga wcześniejszego wyłączenia konta (409) — anonimizacja aktywnego konta
 * wyrzuciłaby zalogowaną osobę bez śladu decyzji administratora.
 */
export function anonymizeUser(db: Db, id: string): AnonymizeUserResult {
  const tx = db.transaction((): AnonymizeUserResult => {
    const row = getUserById(db, id);
    if (row === null) throw new AppError('not_found', `Użytkownik nie istnieje: ${id}`);
    if (row.status !== 'disabled') {
      throw new AppError(
        'conflict',
        'Anonimizacja wymaga wcześniejszego wyłączenia konta (status=disabled)',
      );
    }
    if (row.email === null && row.sub !== null && row.sub.startsWith('anon:')) {
      throw new AppError('conflict', 'Konto zostało już zanonimizowane');
    }

    const now = nowIso();
    const nextSub =
      row.sub === null ? null : `anon:${createHash('sha256').update(row.sub).digest('hex')}`;
    db.prepare(
      'UPDATE users SET sub = ?, email = NULL, display_name = ?, updated_at = ? WHERE id = ?',
    ).run(nextSub, ANONYMIZED_DISPLAY_NAME, now, id);

    const revokedKeys = db
      .prepare(
        "UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'",
      )
      .run(now, id).changes;
    const deletedSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id).changes;
    const detachedAnswers = db
      .prepare('UPDATE answers SET user_id = NULL WHERE user_id = ?')
      .run(id).changes;

    return {
      user: getUserById(db, id) as UserRow,
      revokedKeys,
      deletedSessions,
      detachedAnswers,
    };
  });
  return tx.immediate();
}
