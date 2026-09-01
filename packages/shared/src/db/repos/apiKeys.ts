import type { Db } from '../open.js';
import { nowIso } from '../open.js';
import { AppError } from '../../errors.js';
import { generateApiKey, hashToken, timingSafeEqualStr } from '../../crypto/keys.js';
import { hex8 } from './util.js';

/** Klucze API MCP: raw pokazany JEDEN raz, w DB tylko sha256 + prefix (crypto/keys.ts). */

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

/** Pełny wiersz DB — używany tylko wewnętrznie (zawiera hash). */
interface ApiKeyDbRow {
  id: string;
  user_id: string;
  label: string;
  prefix: string;
  hash: string;
  scopes_json: string;
  profile_id: string;
  status: ApiKeyStatus;
  created_at: string;
  created_by: string;
  expires_at: string;
  last_used_at: string | null;
  requests_count: number;
  revoked_at: string | null;
}

/** Kształt publiczny — NIGDY nie zawiera hasha. */
export type ApiKeyRow = Omit<ApiKeyDbRow, 'hash'>;

function stripHash({ hash: _hash, ...rest }: ApiKeyDbRow): ApiKeyRow {
  return rest;
}

export interface CreateKeyResult {
  row: ApiKeyRow;
  /** Surowy klucz — do pokazania użytkownikowi dokładnie raz. */
  raw: string;
}

export function createKey(
  db: Db,
  userId: string,
  label: string,
  scopes: string[],
  profileId: string,
  ttlDays: number,
  createdBy?: string,
): CreateKeyResult {
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
    throw new AppError('validation_error', 'ttlDays musi być liczbą całkowitą 1..365');
  }
  const generated = generateApiKey();
  const now = new Date();
  const id = `key_${hex8()}${hex8()}`;
  db.prepare(
    `INSERT INTO api_keys (id, user_id, label, prefix, hash, scopes_json, profile_id, status,
       created_at, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    id,
    userId,
    label,
    generated.prefix,
    generated.hash,
    JSON.stringify(scopes),
    profileId,
    now.toISOString(),
    createdBy ?? userId,
    new Date(now.getTime() + ttlDays * 86_400_000).toISOString(),
  );
  return { row: stripHash(getDbRowOrThrow(db, id)), raw: generated.raw };
}

function getDbRow(db: Db, id: string): ApiKeyDbRow | null {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyDbRow | undefined;
  return row ?? null;
}

function getDbRowOrThrow(db: Db, id: string): ApiKeyDbRow {
  const row = getDbRow(db, id);
  if (!row) throw new AppError('not_found', `klucz nie istnieje: ${id}`);
  return row;
}

/**
 * Weryfikacja tokenu: lookup po sha256(raw), status active, expires_at > now.
 * BEZ ŻADNEGO ZAPISU (gorąca ścieżka MCP; last_used batchowany przez touchUsage).
 */
export function verifyKey(db: Db, rawToken: string): ApiKeyRow | null {
  const digest = hashToken(rawToken);
  const row = db.prepare('SELECT * FROM api_keys WHERE hash = ?').get(digest) as
    | ApiKeyDbRow
    | undefined;
  if (!row) return null;
  // Porównanie stałoczasowe hasha (defense-in-depth mimo lookupu po indeksie).
  if (!timingSafeEqualStr(digest, row.hash)) return null;
  if (row.status !== 'active') return null;
  if (row.expires_at <= nowIso()) return null;
  return stripHash(row);
}

/** Batch aktualizacji last_used_at/requests_count (flush co ~30 s z pamięci mcp-servera). */
export function touchUsage(db: Db, ids: string[]): void {
  if (ids.length === 0) return;
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const stmt = db.prepare(
    'UPDATE api_keys SET last_used_at = ?, requests_count = requests_count + ? WHERE id = ?',
  );
  const tx = db.transaction(() => {
    const now = nowIso();
    for (const [id, n] of counts) stmt.run(now, n, id);
  });
  tx.immediate();
}

/** Rotate: nowy raw (nowy wiersz z tymi samymi atrybutami), stary revoked — jedna transakcja. */
export function rotateKey(db: Db, id: string, rotatedBy?: string): CreateKeyResult {
  const generated = generateApiKey();
  const tx = db.transaction(() => {
    const old = getDbRowOrThrow(db, id);
    if (old.status !== 'active') {
      throw new AppError('conflict', `rotate możliwy tylko dla klucza active (status: ${old.status})`);
    }
    const now = nowIso();
    db.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now, id);
    const newId = `key_${hex8()}${hex8()}`;
    db.prepare(
      `INSERT INTO api_keys (id, user_id, label, prefix, hash, scopes_json, profile_id, status,
         created_at, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      newId,
      old.user_id,
      old.label,
      generated.prefix,
      generated.hash,
      old.scopes_json,
      old.profile_id,
      now,
      rotatedBy ?? old.created_by,
      old.expires_at, // TTL bez wydłużania — rotacja nie przedłuża życia klucza
    );
    return stripHash(getDbRowOrThrow(db, newId));
  });
  return { row: tx.immediate(), raw: generated.raw };
}

export function revokeKey(db: Db, id: string): ApiKeyRow {
  const tx = db.transaction(() => {
    const row = getDbRowOrThrow(db, id);
    if (row.status !== 'active') {
      throw new AppError('conflict', `klucz nie jest active (status: ${row.status})`);
    }
    db.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?").run(nowIso(), id);
    return stripHash(getDbRowOrThrow(db, id));
  });
  return tx.immediate();
}

export function getKey(db: Db, id: string): ApiKeyRow | null {
  const row = getDbRow(db, id);
  return row ? stripHash(row) : null;
}

export function listKeysForUser(db: Db, userId: string): ApiKeyRow[] {
  const rows = db
    .prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as ApiKeyDbRow[];
  return rows.map(stripHash);
}

export function listAllKeys(db: Db): ApiKeyRow[] {
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as ApiKeyDbRow[];
  return rows.map(stripHash);
}

/** Sweep TTL: active z expires_at < now → expired. Zwraca liczbę zmian. */
export function expireSweep(db: Db): number {
  return db
    .prepare("UPDATE api_keys SET status = 'expired' WHERE status = 'active' AND expires_at < ?")
    .run(nowIso()).changes;
}

export function keyScopes(row: ApiKeyRow): string[] {
  try {
    return JSON.parse(row.scopes_json) as string[];
  } catch {
    return [];
  }
}
