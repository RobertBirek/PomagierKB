import type { Db, KbRow, KbStatus } from '@pomagierkb/shared/db';
import {
  createKb,
  getKbOrThrow,
  latestExportRun,
  listDrafts,
  listActions,
  listKbs,
  nowIso,
  transitionKb,
  kbRoutingKeywords,
} from '@pomagierkb/shared/db';
import { getSetting } from '@pomagierkb/shared/db';
import { unseal } from '@pomagierkb/shared/crypto';
import { AppError } from '@pomagierkb/shared/errors';
import { OpenSpgClient, listProjects } from '@pomagierkb/shared/openspg';
import type { AppConfig } from '../config.js';

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

// ── Ustawienia embeddingu (settings 'llm.embeddings', sealed AES-GCM) ───────

export interface EmbeddingsSettings {
  model: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Odczyt konfiguracji embeddings z settings (sekret sealowany kluczem TOKEN_ENC_KEY).
 * Brak/niepełna/nieodszyfrowywalna konfiguracja → null (wołający decyduje o komunikacie).
 */
export function readEmbeddingsSettings(db: Db, config: AppConfig): EmbeddingsSettings | null {
  let value: unknown;
  try {
    const setting = getSetting(db, 'llm.embeddings', {
      unseal: (sealed) => unseal(sealed, config.tokenEncKey.toString('base64')),
    });
    if (!setting) return null;
    value = setting.value;
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const model = o['model'];
  const baseUrl = o['baseUrl'];
  const apiKey = o['apiKey'];
  if (typeof model !== 'string' || model === '') return null;
  if (typeof baseUrl !== 'string' || baseUrl === '') return null;
  if (typeof apiKey !== 'string' || apiKey === '') return null;
  return { model, baseUrl, apiKey };
}

/** Nazwa modelu z modelId '<instanceId>@<model>' (brak '@' → cała wartość). */
export function modelNameOf(vectorModelId: string): string {
  const at = vectorModelId.indexOf('@');
  return at === -1 ? vectorModelId : vectorModelId.slice(at + 1);
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

// ── Preflight buildu ────────────────────────────────────────────────────────

export interface PreflightCheck {
  id: string;
  ok: boolean;
  severity: 'error' | 'warn';
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

/**
 * Dry-run buildu KB (POST /kbs/:ns/preflight; build w Fazie 4 użyje tych samych
 * checków przed startem).
 *
 * UWAGA (integracja z services/preflight.ts): silnik akcji ma własną kompozycję
 * 'build_kb', ale jego check embeddingu czyta settings BEZ unseal (sekret
 * sealowany → null → warn), więc NIE egzekwuje twardego guardu niezmienności.
 * Ten preflight czyta sekret przez unseal i porównuje ZAMROŻONY vector_model_id
 * — do scalenia w Fazie 4 przy implementacji akcji build_kb.
 * Checki:
 * - kb_active: status active + project_id (error);
 * - embedding_model: GUARD NIEZMIENNOŚCI — zamrożony vector_model_id musi zgadzać
 *   się z modelem w settings 'llm.embeddings' (error przy rozjeździe/braku konfiguracji);
 * - openspg_reachable: /v1/projects/list odpowiada (error);
 * - promoted_drafts: eksport da ≥1 dokument (error);
 * - no_running_build: brak innej akcji build_kb dla tego KB (error).
 */
export async function preflightBuild(
  deps: { db: Db; config: AppConfig; client: OpenSpgClient },
  namespace: string,
): Promise<PreflightResult> {
  const { db, config, client } = deps;
  const kb = getKbOrThrow(db, namespace);
  const checks: PreflightCheck[] = [];

  const active = kb.status === 'active' && kb.project_id !== null;
  checks.push({
    id: 'kb_active',
    ok: active,
    severity: 'error',
    message: active
      ? `baza active (projekt OpenSPG #${kb.project_id})`
      : `baza nie jest gotowa do buildu (status: ${kb.status}, projectId: ${kb.project_id ?? 'brak'})`,
  });

  // Guard niezmienności embeddingu: modelu NIE wolno zmieniać po utworzeniu projektu.
  const embeddings = readEmbeddingsSettings(db, config);
  if (kb.vector_model_id !== '') {
    const frozen = modelNameOf(kb.vector_model_id);
    if (embeddings === null) {
      checks.push({
        id: 'embedding_model',
        ok: false,
        severity: 'error',
        message: `brak konfiguracji llm.embeddings w Ustawieniach (projekt zamrożony na modelu '${frozen}')`,
      });
    } else if (embeddings.model !== frozen) {
      checks.push({
        id: 'embedding_model',
        ok: false,
        severity: 'error',
        message: `model embeddingu w Ustawieniach ('${embeddings.model}') różni się od zamrożonego w projekcie ('${frozen}') — modelu NIE wolno zmieniać po utworzeniu projektu`,
      });
    } else {
      checks.push({
        id: 'embedding_model',
        ok: true,
        severity: 'error',
        message: `model embeddingu zgodny ('${frozen}')`,
      });
    }
  } else {
    checks.push({
      id: 'embedding_model',
      ok: false,
      severity: 'warn',
      message: 'baza bez zamrożonego modelu embeddingu (provisioning niekompletny?)',
    });
  }

  try {
    await listProjects(client);
    checks.push({ id: 'openspg_reachable', ok: true, severity: 'error', message: 'OpenSPG odpowiada' });
  } catch (err) {
    checks.push({
      id: 'openspg_reachable',
      ok: false,
      severity: 'error',
      message: `OpenSPG nie odpowiada: ${(err as Error).message}`,
    });
  }

  const promoted = listDrafts(db, { namespace, status: 'promoted', limit: 1 }).total;
  checks.push({
    id: 'promoted_drafts',
    ok: promoted > 0,
    severity: 'error',
    message:
      promoted > 0
        ? `wypromowanych draftów: ${promoted}`
        : 'brak wypromowanych draftów — eksport nie da żadnego dokumentu',
  });

  const running = listActions(db, { type: 'build_kb', resource: `kb:${namespace}`, status: 'running', limit: 1 });
  checks.push({
    id: 'no_running_build',
    ok: running.total === 0,
    severity: 'error',
    message:
      running.total === 0
        ? 'brak trwającego builda'
        : `build już trwa (actionId: ${running.items[0]?.id ?? '?'})`,
  });

  return { ok: !checks.some((c) => !c.ok && c.severity === 'error'), checks };
}
