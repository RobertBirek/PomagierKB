import type { Db } from '@pomagierkb/shared/db';
import {
  createKey,
  getKey,
  getProfileOrThrow,
  keyScopes,
  listAllKeys,
  listKeysForUser,
  profileTools,
  revokeKey,
  rotateKey,
  type ApiKeyRow,
  type CreateKeyResult,
  type McpProfileRow,
} from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import type { AppConfig } from '../config.js';
import type { AppUser } from '../types.js';

/**
 * Serwis administracji MCP: klucze API (create/rotate/revoke z regułami ról),
 * best-effort invalidacja cache mcp-servera, snippety konfiguracyjne i health.
 * Profile MCP obsługuje bezpośrednio repo shared (walidacja tools/namespaces tam).
 */

const MAX_ACTIVE_KEYS_PER_USER = 5;

/** Kształt profilu dla API: tools/namespaces jako tablice zamiast surowych *_json. */
export interface McpProfileView {
  id: string;
  name: string;
  description: string | null;
  namespaces: string[] | null;
  tools: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toProfileView(row: McpProfileRow): McpProfileView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    namespaces: row.namespaces_json === null ? null : (JSON.parse(row.namespaces_json) as string[]),
    tools: profileTools(row),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Kształt klucza dla API: scopes jako tablica (bez surowego scopes_json). */
export interface ApiKeyView {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  scopes: string[];
  profileId: string;
  status: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  lastUsedAt: string | null;
  requestsCount: number;
  revokedAt: string | null;
}

export function toKeyView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    prefix: row.prefix,
    scopes: keyScopes(row),
    profileId: row.profile_id,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    requestsCount: row.requests_count,
    revokedAt: row.revoked_at,
  };
}

/** GET /mcp/keys — viewer/operator: własne; admin: wszystkie (opcjonalnie ?userId=). */
export function listKeys(db: Db, user: AppUser, userId?: string): ApiKeyView[] {
  if (user.role !== 'admin') {
    return listKeysForUser(db, user.id).map(toKeyView);
  }
  const rows = userId !== undefined ? listKeysForUser(db, userId) : listAllKeys(db);
  return rows.map(toKeyView);
}

export interface CreateKeyInput {
  label: string;
  profileId: string;
  /** Default: klucz dla samego siebie. Inny user — tylko admin. */
  userId?: string;
  /** Default ['read']; 'write' — tylko admin. */
  scopes?: string[];
  /** Wymagane 1..365 (schema daje default 90). */
  ttlDays: number;
}

interface UserRow {
  id: string;
  status: string;
}

function getActiveUserOrThrow(db: Db, userId: string): UserRow {
  const row = db.prepare('SELECT id, status FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!row) throw new AppError('not_found', `użytkownik nie istnieje: ${userId}`);
  if (row.status !== 'active') {
    throw new AppError('conflict', `użytkownik ${userId} jest wyłączony — nie można wystawić klucza`);
  }
  return row;
}

/**
 * POST /mcp/keys — reguły z backend-mcp §2.2/§7.7:
 * - operator: WYŁĄCZNIE własny klucz i wyłącznie scope ['read'];
 * - admin: dowolny user (człowiek lub serwisowy) i opcjonalnie scope write;
 * - limit 5 aktywnych kluczy per user; profil musi istnieć.
 * Raw zwracany DOKŁADNIE raz — nigdzie nie zapisywany poza sha256 w DB.
 */
export function createKeyForUser(db: Db, actor: AppUser, input: CreateKeyInput): CreateKeyResult {
  const targetUserId = input.userId ?? actor.id;
  const scopes = input.scopes ?? ['read'];

  if (actor.role !== 'admin') {
    if (targetUserId !== actor.id) {
      throw new AppError('forbidden', 'Tylko admin może wystawić klucz dla innego użytkownika');
    }
    if (scopes.some((s) => s !== 'read')) {
      throw new AppError('forbidden', 'Tylko admin może wystawić klucz ze scope write');
    }
  }

  getActiveUserOrThrow(db, targetUserId);
  getProfileOrThrow(db, input.profileId); // 404 zamiast gołego błędu FK

  const active = (
    db
      .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND status = 'active'")
      .get(targetUserId) as { n: number }
  ).n;
  if (active >= MAX_ACTIVE_KEYS_PER_USER) {
    throw new AppError('conflict', `limit ${MAX_ACTIVE_KEYS_PER_USER} aktywnych kluczy na użytkownika osiągnięty`, {
      activeKeys: active,
    });
  }

  return createKey(db, targetUserId, input.label, scopes, input.profileId, input.ttlDays, actor.id);
}

/** Właściciel lub admin — inaczej 403 (bez ujawniania cudzych kluczy: brak → 404). */
function getOwnedKeyOrThrow(db: Db, actor: AppUser, id: string): ApiKeyRow {
  const row = getKey(db, id);
  if (!row) throw new AppError('not_found', `klucz nie istnieje: ${id}`);
  if (actor.role !== 'admin' && row.user_id !== actor.id) {
    throw new AppError('forbidden', 'Klucz należy do innego użytkownika');
  }
  return row;
}

export function rotateKeyAs(db: Db, actor: AppUser, id: string): CreateKeyResult {
  getOwnedKeyOrThrow(db, actor, id);
  return rotateKey(db, id, actor.id);
}

export function revokeKeyAs(db: Db, actor: AppUser, id: string): ApiKeyRow {
  getOwnedKeyOrThrow(db, actor, id);
  return revokeKey(db, id);
}

// ── Best-effort invalidacja cache mcp-servera ──────────────────────────────

export interface InvalidateDeps {
  fetchImpl?: typeof fetch;
  logger?: { warn(obj: Record<string, unknown>, msg?: string): void };
}

/**
 * POST {MCP_INTERNAL_URL}/invalidate z nagłówkiem X-Internal-Token — po rotate
 * i revoke, żeby cache LRU mcp-servera nie honorował klucza do 60 s.
 * BEST-EFFORT: timeout 2 s, każdy błąd tylko logowany (odpowiedź API bez zmian).
 */
export async function invalidateMcpCache(config: AppConfig, deps: InvalidateDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetchImpl(`${config.mcpInternalUrl}/invalidate`, {
      method: 'POST',
      headers: { 'x-internal-token': config.internalToken },
      signal: controller.signal,
    });
    if (!res.ok) {
      deps.logger?.warn({ status: res.status }, 'mcp invalidate: odpowiedź nie-2xx (ignoruję)');
    }
  } catch (err) {
    deps.logger?.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'mcp invalidate: niedostępny (ignoruję)',
    );
  } finally {
    clearTimeout(timer);
  }
}

// ── Snippety konfiguracyjne ────────────────────────────────────────────────

export const KEY_PLACEHOLDER = '<TWÓJ_KLUCZ>';

export interface McpSnippets {
  profileId: string;
  url: string;
  snippets: {
    claudeCode: string;
    cursor: string;
    generic: string;
  };
}

/**
 * GET /mcp/snippets?profileId — bloki konfiguracyjne z URL-em profilu
 * i placeholderem klucza. NIGDY z prawdziwym kluczem (raw istnieje tylko
 * w momencie create/rotate).
 */
export function buildSnippets(db: Db, config: AppConfig, profileId: string): McpSnippets {
  const profile = getProfileOrThrow(db, profileId);
  const url = `${config.publicUrl}/mcp/${profile.id}`;
  const headers = { Authorization: `Bearer ${KEY_PLACEHOLDER}` };

  const claudeCode = `claude mcp add --transport http kag ${url} --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`;
  const cursor = JSON.stringify({ mcpServers: { kag: { url, headers } } }, null, 2);
  const generic = JSON.stringify({ type: 'http', url, headers }, null, 2);

  return { profileId: profile.id, url, snippets: { claudeCode, cursor, generic } };
}

// ── Health mcp-servera ─────────────────────────────────────────────────────

export interface McpHealthResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  detail: string;
}

/** GET /mcp/health — ping healthchecku mcp-servera (timeout 3 s). */
export async function checkMcpHealth(
  config: AppConfig,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<McpHealthResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(config.mcpHealthUrl, { method: 'GET', signal: controller.signal });
    return {
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - startedAt,
      detail: res.ok ? 'mcp-server odpowiada' : `mcp-server zwrócił ${res.status}`,
    };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      detail: timedOut ? 'timeout healthchecku (3 s)' : 'mcp-server niedostępny',
    };
  } finally {
    clearTimeout(timer);
  }
}
