import type { Db } from '../open.js';
import { nowIso } from '../open.js';
import { AppError } from '../../errors.js';
import { isConstraintError, parseJson } from './util.js';
import { coercePiiPolicy, type PiiPolicy } from '../../pii/index.js';

/** Rejestr KB — JEDYNE źródło prawdy o bazach wiedzy (kb_registry). */

export const NAMESPACE_RE = /^[A-Z][A-Za-z0-9]{2,29}$/;

export type KbStatus = 'draft' | 'provisioning' | 'active' | 'error' | 'archived';

export interface KbRow {
  namespace: string;
  name: string;
  description: string;
  project_id: number | null;
  status: KbStatus;
  vector_model_id: string;
  embedding_model: string;
  schema_version: number;
  schema_hash: string;
  job_prefix: string;
  routing_keywords: string;
  is_default: number;
  dirty: number;
  config_json: string;
  pii_policy: string;
  created_at: string;
  updated_at: string;
}

/** Dozwolone przejścia stanów KB (nielegalne = 409 conflict). */
const TRANSITIONS: Record<KbStatus, KbStatus[]> = {
  draft: ['provisioning', 'archived'],
  provisioning: ['active', 'error'],
  active: ['error', 'archived'],
  error: ['provisioning', 'archived'],
  archived: [],
};

export interface KbCreateInput {
  namespace: string;
  name: string;
  description?: string;
  embeddingModel?: string;
  routingKeywords?: string[];
  config?: Record<string, unknown>;
  jobPrefix?: string;
}

/** job_prefix z wielkich liter namespace (np. LightingDocs → 'LD'), ≤8 znaków. */
export function deriveJobPrefix(namespace: string): string {
  const caps = namespace.replace(/[^A-Z0-9]/g, '');
  return (caps || namespace.toUpperCase()).slice(0, 8);
}

export function createKb(db: Db, input: KbCreateInput): KbRow {
  if (!NAMESPACE_RE.test(input.namespace)) {
    throw new AppError('validation_error', `namespace nie spełnia ^[A-Z][A-Za-z0-9]{2,29}$: ${input.namespace}`);
  }
  const now = nowIso();
  const jobPrefix = (input.jobPrefix ?? deriveJobPrefix(input.namespace)).slice(0, 8);
  try {
    db.prepare(
      `INSERT INTO kb_registry (namespace, name, description, status, job_prefix,
         embedding_model, routing_keywords, config_json, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.namespace,
      input.name,
      input.description ?? '',
      jobPrefix,
      input.embeddingModel ?? '',
      JSON.stringify(input.routingKeywords ?? []),
      JSON.stringify(input.config ?? {}),
      now,
      now,
    );
  } catch (err) {
    if (isConstraintError(err)) {
      throw new AppError('conflict', `namespace już istnieje: ${input.namespace}`);
    }
    throw err;
  }
  return getKbOrThrow(db, input.namespace);
}

export function getKb(db: Db, namespace: string): KbRow | null {
  const row = db.prepare('SELECT * FROM kb_registry WHERE namespace = ?').get(namespace) as
    | KbRow
    | undefined;
  return row ?? null;
}

export function getKbOrThrow(db: Db, namespace: string): KbRow {
  const row = getKb(db, namespace);
  if (!row) throw new AppError('not_found', `baza nie istnieje: ${namespace}`);
  return row;
}

export function listKbs(db: Db, filter?: { status?: KbStatus }): KbRow[] {
  if (filter?.status) {
    return db
      .prepare('SELECT * FROM kb_registry WHERE status = ? ORDER BY namespace')
      .all(filter.status) as KbRow[];
  }
  return db.prepare('SELECT * FROM kb_registry ORDER BY namespace').all() as KbRow[];
}

/** Przejście stanu w transakcji; nielegalne → 409 conflict. */
export function transitionKb(db: Db, namespace: string, to: KbStatus): KbRow {
  const tx = db.transaction(() => {
    const row = getKbOrThrow(db, namespace);
    if (!TRANSITIONS[row.status].includes(to)) {
      throw new AppError('conflict', `nielegalne przejście stanu KB: ${row.status} → ${to}`, {
        from: row.status,
        to,
      });
    }
    db.prepare('UPDATE kb_registry SET status = ?, updated_at = ? WHERE namespace = ?').run(
      to,
      nowIso(),
      namespace,
    );
    return getKbOrThrow(db, namespace);
  });
  return tx.immediate();
}

/** Zapis wyniku provisioningu OpenSPG (projectId + zamrożony model wektorowy + hash schemy). */
export function setProvisioned(
  db: Db,
  namespace: string,
  projectId: number,
  vectorModelId: string,
  schemaHash: string,
): KbRow {
  const tx = db.transaction(() => {
    getKbOrThrow(db, namespace);
    db.prepare(
      `UPDATE kb_registry
       SET project_id = ?, vector_model_id = ?, schema_hash = ?,
           schema_version = schema_version + 1, updated_at = ?
       WHERE namespace = ?`,
    ).run(projectId, vectorModelId, schemaHash, nowIso(), namespace);
    return getKbOrThrow(db, namespace);
  });
  return tx.immediate();
}

/** dirty=1: są promocje/withdraw od ostatniego builda. */
export function markDirty(db: Db, namespace: string): void {
  db.prepare('UPDATE kb_registry SET dirty = 1, updated_at = ? WHERE namespace = ?').run(
    nowIso(),
    namespace,
  );
}

export function clearDirty(db: Db, namespace: string): void {
  db.prepare('UPDATE kb_registry SET dirty = 0, updated_at = ? WHERE namespace = ?').run(
    nowIso(),
    namespace,
  );
}

/** Dokładnie jeden KB domyślny (fallback routingu analyze). */
export function setDefaultKb(db: Db, namespace: string): void {
  const tx = db.transaction(() => {
    getKbOrThrow(db, namespace);
    db.prepare('UPDATE kb_registry SET is_default = 0 WHERE is_default = 1').run();
    db.prepare('UPDATE kb_registry SET is_default = 1, updated_at = ? WHERE namespace = ?').run(
      nowIso(),
      namespace,
    );
  });
  tx.immediate();
}

/** Słowa kluczowe routingu jako tablica (kolumna JSON). */
export function kbRoutingKeywords(row: KbRow): string[] {
  return parseJson<string[]>(row.routing_keywords, []);
}

/** Kolejność restrykcyjności polityki PII — im wyżej, tym mniej wolno wysłać. */
const PII_STRICTNESS: Record<PiiPolicy, number> = { off: 0, flag: 1, mask: 2 };

/** Polityka pojedynczej bazy (kolumna `pii_policy`, nieznana wartość → domyślna). */
export function kbPiiPolicy(row: KbRow): PiiPolicy {
  return coercePiiPolicy(row.pii_policy);
}

/** Najostrzejsza z podanych polityk; pusta lista → domyślna, nigdy `off`. */
export function strictestPiiPolicy(policies: readonly PiiPolicy[]): PiiPolicy {
  if (policies.length === 0) return coercePiiPolicy(undefined);
  let strictest: PiiPolicy = 'off';
  for (const policy of policies) {
    if (PII_STRICTNESS[policy] > PII_STRICTNESS[strictest]) strictest = policy;
  }
  return strictest;
}

/**
 * Polityka PII dla ZBIORU baz wiedzy — wygrywa NAJOSTRZEJSZA.
 *
 * Odpowiedź potrafi łączyć fragmenty z kilku baz w jednym promptcie. Gdyby wygrywała
 * polityka luźniejsza, dopisanie jednej bazy z `off` cicho wyłączyłoby maskowanie dla
 * wszystkich pozostałych — dokładnie ten rodzaj regresji, którego nikt nie zauważy.
 * Nieznany namespace (skasowana baza, literówka) też podnosi poprzeczkę do domyślnej,
 * zamiast obniżać ją do zera.
 */
export function piiPolicyFor(db: Db, namespaces: readonly string[]): PiiPolicy {
  if (namespaces.length === 0) return coercePiiPolicy(undefined);
  const placeholders = namespaces.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT namespace, pii_policy FROM kb_registry WHERE namespace IN (${placeholders})`)
    .all(...namespaces) as { namespace: string; pii_policy: string }[];
  const found = new Map(rows.map((r) => [r.namespace, coercePiiPolicy(r.pii_policy)]));
  // Namespace nieznany rejestrowi (skasowana baza, literówka) podnosi poprzeczkę do
  // domyślnej, zamiast po cichu obniżać ją do zera.
  return strictestPiiPolicy(namespaces.map((ns) => found.get(ns) ?? coercePiiPolicy(undefined)));
}
