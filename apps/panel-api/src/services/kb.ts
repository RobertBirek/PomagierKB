import type { Db, KbRow, KbStatus } from '@pomagierkb/shared/db';
import {
  createKb,
  getKbOrThrow,
  latestExportRun,
  listDrafts,
  listKbs,
  nowIso,
  transitionKb,
  kbRoutingKeywords,
} from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import { OpenSpgClient } from '@pomagierkb/shared/openspg';
import type { AppConfig } from '../config.js';
import { modelNameOf } from './embeddings.js';
import { runPreflightFor, type PreflightResult } from './preflight.js';

// Helpery embeddingów wydzielone do services/embeddings.ts (współdzielone
// z kompozycją preflightu bez cyklu importów) — re-eksport dla dotychczasowych
// importerów (jobs/create-kb.ts, testy).
export { readEmbeddingsSettings, modelNameOf, type EmbeddingsSettings } from './embeddings.js';

/**
 * Serwis rejestru KB (nad repo kbRegistry z shared): create/list/get/patch/archive,
 * totalsy z cache 10 s, wersje schematu (schema_versions), preflight buildu
 * z guardem niezmienności embeddingu oraz pomocniki OpenSPG dla tras/jobów.
 * Rejestr w SQLite to JEDYNE źródło prawdy o bazach — żadnych list w kodzie.
 */

// ── Typy API ────────────────────────────────────────────────────────────────

/** Typ dokumentu zadeklarowany dla KB (fundament Kreatora KB v1) — config_json.documentTypes. */
export interface DocumentTypeDef {
  name: string;
  description: string;
}

export interface KbTotals {
  documents: number;
  chunks: number;
  pendingDrafts: number;
}

export interface KbEntryApi {
  namespace: string;
  name: string;
  description: string;
  projectId: number | null;
  status: KbStatus;
  dirty: boolean;
  schemaVersion: number;
  vectorModelId: string;
  jobPrefix: string;
  isDefault: boolean;
  routingKeywords: string[];
  documentTypes: DocumentTypeDef[];
  totals: KbTotals;
  createdAt: string;
  updatedAt: string;
}

// ── documentTypes (Kreator KB v1) ───────────────────────────────────────────

/** Walidacja listy typów dokumentów: niepuste nazwy, bez duplikatów (case-insensitive). */
export function validateDocumentTypes(input: unknown): DocumentTypeDef[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new AppError('validation_error', 'documentTypes musi być tablicą {name, description}');
  }
  const out: DocumentTypeDef[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      throw new AppError('validation_error', 'documentTypes: element musi być obiektem {name, description}');
    }
    const o = item as Record<string, unknown>;
    const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
    if (name === '') {
      throw new AppError('validation_error', 'documentTypes: każdy typ dokumentu wymaga niepustej nazwy');
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new AppError('validation_error', `documentTypes: zduplikowana nazwa typu dokumentu: ${name}`);
    }
    seen.add(key);
    const description = typeof o['description'] === 'string' ? o['description'] : '';
    out.push({ name, description });
  }
  return out;
}

/** Typy dokumentów z config_json wiersza rejestru (defensywnie — zła zawartość → []). */
export function documentTypesOf(row: KbRow): DocumentTypeDef[] {
  try {
    const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
    return validateDocumentTypes(cfg['documentTypes']);
  } catch {
    return [];
  }
}

// ── Totalsy z cache 10 s (per instancja db — WeakMap nie przecieka w testach) ──

const TOTALS_TTL_MS = 10_000;
const totalsCache = new WeakMap<Db, { at: number; byNs: Map<string, KbTotals> }>();

export function clearKbTotalsCache(db: Db): void {
  totalsCache.delete(db);
}

function computeTotals(db: Db, namespace: string): KbTotals {
  // Liczniki przez repo drafts (total z listy limit=1) + manifesty eksportów.
  const pendingDrafts = listDrafts(db, { namespace, status: 'pending', limit: 1 }).total;
  const promoted = listDrafts(db, { namespace, status: 'promoted', limit: 1 }).total;
  const run = latestExportRun(db, namespace);
  const documents =
    run?.status === 'success' && run.doc_count !== null ? run.doc_count : promoted;
  const chunks = run?.status === 'success' && run.chunk_count !== null ? run.chunk_count : 0;
  return { documents, chunks, pendingDrafts };
}

function totalsFor(db: Db, namespace: string): KbTotals {
  let entry = totalsCache.get(db);
  if (!entry || Date.now() - entry.at > TOTALS_TTL_MS) {
    entry = { at: Date.now(), byNs: new Map() };
    totalsCache.set(db, entry);
  }
  let totals = entry.byNs.get(namespace);
  if (!totals) {
    totals = computeTotals(db, namespace);
    entry.byNs.set(namespace, totals);
  }
  return totals;
}

// ── CRUD rejestru ───────────────────────────────────────────────────────────

export function kbToApi(db: Db, row: KbRow): KbEntryApi {
  return {
    namespace: row.namespace,
    name: row.name,
    description: row.description,
    projectId: row.project_id,
    status: row.status,
    dirty: row.dirty === 1,
    schemaVersion: row.schema_version,
    vectorModelId: row.vector_model_id,
    jobPrefix: row.job_prefix,
    isDefault: row.is_default === 1,
    routingKeywords: kbRoutingKeywords(row),
    documentTypes: documentTypesOf(row),
    totals: totalsFor(db, row.namespace),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface KbCreateEntryInput {
  namespace: string;
  name: string;
  description?: string;
  documentTypes?: unknown;
}

/** Tworzy wpis rejestru (status draft); documentTypes ląduje w config_json. */
export function createKbEntry(db: Db, input: KbCreateEntryInput): KbRow {
  const documentTypes = validateDocumentTypes(input.documentTypes);
  const row = createKb(db, {
    namespace: input.namespace,
    name: input.name.trim(),
    description: input.description ?? '',
    config: { documentTypes },
  });
  clearKbTotalsCache(db);
  return row;
}

export function listKbEntries(db: Db): KbEntryApi[] {
  return listKbs(db).map((row) => kbToApi(db, row));
}

export function getKbEntry(db: Db, namespace: string): KbEntryApi {
  return kbToApi(db, getKbOrThrow(db, namespace));
}

export interface KbPatch {
  name?: string;
  description?: string;
  status?: KbStatus;
  config?: Record<string, unknown>;
}

/**
 * PATCH: tylko name/description/status/config. Zmiana statusu przechodzi przez
 * transitionKb (legalność przejść; nielegalne → 409). Config jest podmieniany
 * w całości (documentTypes wewnątrz walidowane).
 */
export function patchKbEntry(db: Db, namespace: string, patch: KbPatch): { before: KbRow; after: KbRow } {
  if (patch.config !== undefined && 'documentTypes' in patch.config) {
    validateDocumentTypes(patch.config['documentTypes']);
  }
  const tx = db.transaction(() => {
    const before = getKbOrThrow(db, namespace);
    if (patch.status !== undefined && patch.status !== before.status) {
      transitionKb(db, namespace, patch.status); // zagnieżdżona transakcja = savepoint
    }
    if (patch.name !== undefined || patch.description !== undefined || patch.config !== undefined) {
      const current = getKbOrThrow(db, namespace);
      db.prepare(
        'UPDATE kb_registry SET name = ?, description = ?, config_json = ?, updated_at = ? WHERE namespace = ?',
      ).run(
        patch.name !== undefined ? patch.name.trim() : current.name,
        patch.description !== undefined ? patch.description : current.description,
        patch.config !== undefined ? JSON.stringify(patch.config) : current.config_json,
        nowIso(),
        namespace,
      );
    }
    return { before, after: getKbOrThrow(db, namespace) };
  });
  const result = tx.immediate();
  clearKbTotalsCache(db);
  return result;
}

/** Soft delete: status → archived (projekt OpenSPG NIE jest kasowany). */
export function archiveKb(db: Db, namespace: string): KbRow {
  const row = transitionKb(db, namespace, 'archived');
  clearKbTotalsCache(db);
  return row;
}

// ── Wersje schematu (schema_versions) ───────────────────────────────────────

export interface SchemaVersionRow {
  version: number;
  hash: string;
  content: string;
  created_at: string;
}

/** Ostatnia scommitowana wersja schematu KB (do diff guard). */
export function latestSchemaVersion(db: Db, namespace: string): SchemaVersionRow | null {
  const row = db
    .prepare(
      'SELECT version, hash, content, created_at FROM schema_versions WHERE namespace = ? ORDER BY version DESC LIMIT 1',
    )
    .get(namespace) as SchemaVersionRow | undefined;
  return row ?? null;
}

/**
 * Finalizacja provisioningu (job create_kb) w JEDNEJ transakcji:
 * schema_versions v1 (idempotentnie), project_id + zamrożony vector_model_id
 * + schema_hash + schema_version=1, status provisioning → active.
 */
export function finishProvisioning(
  db: Db,
  namespace: string,
  args: { projectId: number; vectorModelId: string; hash: string; content: string; createdBy: string | null },
): KbRow {
  const tx = db.transaction(() => {
    const row = getKbOrThrow(db, namespace);
    if (row.status !== 'provisioning') {
      throw new AppError('conflict', `finalizacja provisioningu wymaga statusu provisioning (jest: ${row.status})`);
    }
    db.prepare(
      `INSERT INTO schema_versions (namespace, version, hash, content, created_at, created_by)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(namespace, version) DO NOTHING`,
    ).run(namespace, args.hash, args.content, nowIso(), args.createdBy);
    db.prepare(
      `UPDATE kb_registry SET project_id = ?, vector_model_id = ?, embedding_model = ?,
         schema_hash = ?, schema_version = 1, status = 'active', updated_at = ? WHERE namespace = ?`,
    ).run(args.projectId, args.vectorModelId, modelNameOf(args.vectorModelId), args.hash, nowIso(), namespace);
    return getKbOrThrow(db, namespace);
  });
  const row = tx.immediate();
  clearKbTotalsCache(db);
  return row;
}

/** Zapis nowej (addytywnej) wersji schematu po commitSchema (job schema_sync). */
export function recordSchemaVersion(
  db: Db,
  namespace: string,
  args: { version: number; hash: string; content: string; createdBy: string | null },
): KbRow {
  const tx = db.transaction(() => {
    getKbOrThrow(db, namespace);
    db.prepare(
      `INSERT INTO schema_versions (namespace, version, hash, content, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(namespace, args.version, args.hash, args.content, nowIso(), args.createdBy);
    db.prepare(
      'UPDATE kb_registry SET schema_version = ?, schema_hash = ?, updated_at = ? WHERE namespace = ?',
    ).run(args.version, args.hash, nowIso(), namespace);
    return getKbOrThrow(db, namespace);
  });
  return tx.immediate();
}

// ── Klient OpenSPG ──────────────────────────────────────────────────────────

/** Fabryka klienta OpenSPG z konfiguracji aplikacji (fetchImpl wstrzykiwalny w testach). */
export function makeOpenSpgClient(config: AppConfig, fetchImpl?: typeof fetch): OpenSpgClient {
  return new OpenSpgClient({
    baseUrl: config.openspg.baseUrl,
    account: config.openspg.account,
    password: config.openspg.password,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}

// ── Preflight buildu (delegacja do JEDNEJ kompozycji w services/preflight.ts) ──

// Kształt checków 1:1 z silnikiem preflightu (id, ok, severity, message).
export type { PreflightCheckResult as PreflightCheck } from './preflight.js';
export type { PreflightResult } from './preflight.js';

/**
 * Dry-run buildu KB (POST /kbs/:ns/preflight; akcja build_kb używa tych samych
 * checków przed startem). SCALONE w Fazie 4: kompozycja checków żyje wyłącznie
 * w services/preflight.ts (PREFLIGHTS.build_kb) z twardym guardem embeddingu
 * (unseal + zamrożony vector_model_id) — tu tylko delegacja + 404 dla
 * nieistniejącej bazy.
 */
export async function preflightBuild(
  deps: { db: Db; config: AppConfig; client: OpenSpgClient },
  namespace: string,
): Promise<PreflightResult> {
  getKbOrThrow(deps.db, namespace); // 404 zanim polecą checki
  return runPreflightFor('build_kb', {
    db: deps.db,
    config: deps.config,
    namespace,
    openspg: deps.client,
  });
}
