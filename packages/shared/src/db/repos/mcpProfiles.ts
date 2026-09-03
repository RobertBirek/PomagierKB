import type { Db } from '../open.js';
import { nowIso } from '../open.js';
import { AppError } from '../../errors.js';
import { isConstraintError, parseJson } from './util.js';

/** Profile MCP: które narzędzia i namespaces widzi klucz na /mcp/<profil>. */

export const KNOWN_MCP_TOOLS = [
  'kb_search',
  'kb_answer',
  'kb_list',
  'kb_get_source',
  'kb_list_documents',
  'kb_draft_status',
  'kb_submit_draft',
  'kb_feedback',
] as const;

export type McpTool = (typeof KNOWN_MCP_TOOLS)[number];

export interface McpProfileRow {
  id: string;
  name: string;
  description: string | null;
  namespaces_json: string | null; // NULL = wszystkie active z kb_registry
  tools_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function validateTools(tools: string[]): void {
  const unknown = tools.filter((t) => !(KNOWN_MCP_TOOLS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    throw new AppError('validation_error', `nieznane narzędzia MCP: ${unknown.join(', ')}`, {
      known: KNOWN_MCP_TOOLS,
    });
  }
}

function validateNamespaces(db: Db, namespaces: string[] | null): void {
  if (namespaces === null) return;
  const known = new Set(
    (db.prepare('SELECT namespace FROM kb_registry').all() as { namespace: string }[]).map(
      (r) => r.namespace,
    ),
  );
  const unknown = namespaces.filter((ns) => !known.has(ns));
  if (unknown.length > 0) {
    throw new AppError('validation_error', `namespaces spoza rejestru KB: ${unknown.join(', ')}`);
  }
}

export interface McpProfileInput {
  id: string;
  name: string;
  description?: string | null;
  /** null = wszystkie aktywne KB. */
  namespaces?: string[] | null;
  tools: string[];
  enabled?: boolean;
}

export function createProfile(db: Db, input: McpProfileInput): McpProfileRow {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) {
    throw new AppError('validation_error', `id profilu musi być slugiem: ${input.id}`);
  }
  validateTools(input.tools);
  const namespaces = input.namespaces ?? null;
  validateNamespaces(db, namespaces);
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO mcp_profiles (id, name, description, namespaces_json, tools_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.name,
      input.description ?? null,
      namespaces === null ? null : JSON.stringify(namespaces),
      JSON.stringify(input.tools),
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
  } catch (err) {
    if (isConstraintError(err)) throw new AppError('conflict', `profil już istnieje: ${input.id}`);
    throw err;
  }
  return getProfileOrThrow(db, input.id);
}

export function getProfile(db: Db, id: string): McpProfileRow | null {
  const row = db.prepare('SELECT * FROM mcp_profiles WHERE id = ?').get(id) as
    | McpProfileRow
    | undefined;
  return row ?? null;
}

export function getProfileOrThrow(db: Db, id: string): McpProfileRow {
  const row = getProfile(db, id);
  if (!row) throw new AppError('not_found', `profil nie istnieje: ${id}`);
  return row;
}

export function listProfiles(db: Db): McpProfileRow[] {
  return db.prepare('SELECT * FROM mcp_profiles ORDER BY id').all() as McpProfileRow[];
}

export interface McpProfilePatch {
  name?: string;
  description?: string | null;
  namespaces?: string[] | null;
  tools?: string[];
  enabled?: boolean;
}

export function updateProfile(db: Db, id: string, patch: McpProfilePatch): McpProfileRow {
  if (patch.tools !== undefined) validateTools(patch.tools);
  if (patch.namespaces !== undefined) validateNamespaces(db, patch.namespaces);
  const tx = db.transaction(() => {
    const row = getProfileOrThrow(db, id);
    db.prepare(
      `UPDATE mcp_profiles SET name = ?, description = ?, namespaces_json = ?, tools_json = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.name ?? row.name,
      patch.description !== undefined ? patch.description : row.description,
      patch.namespaces !== undefined
        ? patch.namespaces === null
          ? null
          : JSON.stringify(patch.namespaces)
        : row.namespaces_json,
      patch.tools !== undefined ? JSON.stringify(patch.tools) : row.tools_json,
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
      nowIso(),
      id,
    );
    return getProfileOrThrow(db, id);
  });
  return tx.immediate();
}

/** Usunięcie profilu — 409 gdy istnieją AKTYWNE klucze wskazujące na profil. */
export function deleteProfile(db: Db, id: string): void {
  const tx = db.transaction(() => {
    getProfileOrThrow(db, id);
    const active = db
      .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE profile_id = ? AND status = 'active'")
      .get(id) as { n: number };
    if (active.n > 0) {
      throw new AppError('conflict', `profil ma ${active.n} aktywnych kluczy — najpierw je unieważnij`, {
        activeKeys: active.n,
      });
    }
    try {
      db.prepare('DELETE FROM mcp_profiles WHERE id = ?').run(id);
    } catch (err) {
      // FK z api_keys: historyczne (revoked/expired) klucze też blokują usunięcie — profil zostaje.
      if (isConstraintError(err)) {
        throw new AppError('conflict', 'profil ma historyczne klucze — wyłącz go zamiast usuwać');
      }
      throw err;
    }
  });
  tx.immediate();
}

export function profileTools(row: McpProfileRow): string[] {
  return parseJson<string[]>(row.tools_json, []);
}

/**
 * Rozstrzygnięcie namespaces profilu: NULL = wszystkie active z kb_registry;
 * lista = przecięcie z active (archiwalne/nieaktywne KB znikają z widoku klucza).
 */
export function resolveNamespaces(db: Db, profile: McpProfileRow): string[] {
  const active = (
    db.prepare("SELECT namespace FROM kb_registry WHERE status = 'active' ORDER BY namespace").all() as {
      namespace: string;
    }[]
  ).map((r) => r.namespace);
  if (profile.namespaces_json === null) return active;
  const wanted = new Set(parseJson<string[]>(profile.namespaces_json, []));
  return active.filter((ns) => wanted.has(ns));
}
