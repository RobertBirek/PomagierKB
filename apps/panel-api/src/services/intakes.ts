import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '@pomagierkb/shared/db';
import { nowIso } from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import { humanize, INTAKE_STAGES } from './messages.js';

/**
 * Lokalny dostęp SQL do tabeli `intakes` (DDL w shared/db/migrations/0001_init.sql;
 * shared nie ma repo intakes — dostęp celowo lokalny w panel-api, patrz PLAN Faza 4).
 * Czysta logika na db + zapis blobów DATA_DIR/uploads/<sha256[:2]>/<sha256>.
 */

export type IntakeSourceKind = 'upload' | 'text' | 'api' | 'url';
export type IntakeStatus = 'received' | 'extracted' | 'cleaned' | 'analyzed' | 'drafted' | 'failed';

export interface IntakeRow {
  id: string;
  source_kind: IntakeSourceKind;
  original_name: string | null;
  mime: string | null;
  source_url: string | null;
  blob_path: string | null;
  status: IntakeStatus;
  extract_provider: string | null;
  extract_quality: number | null;
  clean_profile: string | null;
  cleaned_chars: number | null;
  removed_ratio: number | null;
  analysis_json: string | null;
  draft_id: string | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  attempts: number;
  size_bytes: number | null;
}

// ── Whitelist rozszerzeń i mapowanie na mime (dane jako stałe) ──────────────

/** Dozwolone rozszerzenia uploadu (pipeline-frontend Etap 1 + formaty tekstowe). */
export const ALLOWED_EXTENSIONS = [
  'md',
  'txt',
  'pdf',
  'html',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'json',
  'xml',
  'yaml',
] as const;

const EXT_TO_MIME: Record<(typeof ALLOWED_EXTENSIONS)[number], string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/x-yaml',
};

/** Rozszerzenie z nazwy pliku (lowercase, bez kropki) albo null. */
export function fileExtension(filename: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename);
  return m?.[1] !== undefined ? m[1].toLowerCase() : null;
}

/** Mime dla dozwolonego rozszerzenia; null gdy rozszerzenie spoza whitelisty. */
export function mimeForExtension(ext: string | null): string | null {
  if (ext === null) return null;
  return (EXT_TO_MIME as Record<string, string>)[ext] ?? null;
}

// ── Blob store: DATA_DIR/uploads/<sha256[:2]>/<sha256> ──────────────────────

export function sha256OfBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Zapis blobu content-addressed (idempotentny: istniejący plik nie jest
 * nadpisywany — ta sama treść = ten sam sha = ta sama ścieżka).
 */
export function saveBlob(dataDir: string, buffer: Buffer): { sha256: string; blobPath: string } {
  const sha256 = sha256OfBuffer(buffer);
  const dir = join(dataDir, 'uploads', sha256.slice(0, 2));
  const blobPath = join(dir, sha256);
  if (!existsSync(blobPath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(blobPath, buffer);
  }
  return { sha256, blobPath };
}

// ── CRUD intakes ────────────────────────────────────────────────────────────

function newIntakeId(): string {
  const d = new Date();
  const ymd =
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}`;
  return `intake_${ymd}_${randomBytes(4).toString('hex')}`;
}

export interface IntakeCreateInput {
  sourceKind: IntakeSourceKind;
  originalName?: string | null;
  mime?: string | null;
  sourceUrl?: string | null;
  blobPath?: string | null;
  createdBy?: string | null;
  sizeBytes?: number | null;
}

export function insertIntake(db: Db, input: IntakeCreateInput): IntakeRow {
  const now = nowIso();
  const id = newIntakeId();
  db.prepare(
    `INSERT INTO intakes (id, source_kind, original_name, mime, source_url, blob_path,
       status, created_by, created_at, updated_at, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?)`,
  ).run(
    id,
    input.sourceKind,
    input.originalName ?? null,
    input.mime ?? null,
    input.sourceUrl ?? null,
    input.blobPath ?? null,
    input.createdBy ?? null,
    now,
    now,
    input.sizeBytes ?? null,
  );
  return getIntakeOrThrow(db, id);
}

export function getIntake(db: Db, id: string): IntakeRow | null {
  const row = db.prepare('SELECT * FROM intakes WHERE id = ?').get(id) as IntakeRow | undefined;
  return row ?? null;
}

export function getIntakeOrThrow(db: Db, id: string): IntakeRow {
  const row = getIntake(db, id);
  if (row === null) throw new AppError('not_found', `intake ${id} nie istnieje`);
  return row;
}

/** Ostatnie intake'y (GET /content?limit) — najnowsze pierwsze. */
export function listIntakes(db: Db, limit: number): IntakeRow[] {
  return db
    .prepare('SELECT * FROM intakes ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as IntakeRow[];
}

/** Łączna liczba intake'ów — meta.total listy /content (backlog ux-audit). */
export function countIntakes(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM intakes').get() as { n: number }).n;
}

/** Dedup po sha256 treści: najnowszy intake wskazujący ten sam blob. */
export function findIntakeByBlobPath(db: Db, blobPath: string): IntakeRow | null {
  const row = db
    .prepare('SELECT * FROM intakes WHERE blob_path = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(blobPath) as IntakeRow | undefined;
  return row ?? null;
}

/** Najstarszy intake w kolejce (status received) — pojedynczy worker in-process. */
/**
 * Następny intake do przetworzenia — najpierw MAŁE/tekstowe (size_bytes rosnąco,
 * NULL-e pierwsze), potem FIFO: jeden 50-megabajtowy skan z OCR-em nie blokuje
 * już drobnych wpisów tekstowych w kolejce.
 */
export function nextReceivedIntake(db: Db, excludeIds: readonly string[] = []): IntakeRow | null {
  const excl = excludeIds.slice(0, 50);
  const notIn = excl.length > 0 ? `AND id NOT IN (${excl.map(() => '?').join(',')})` : '';
  const row = db
    .prepare(
      `SELECT * FROM intakes WHERE status = 'received' ${notIn}
       ORDER BY (size_bytes IS NOT NULL), size_bytes, created_at, id LIMIT 1`,
    )
    .get(...excl) as IntakeRow | undefined;
  return row ?? null;
}

export const INTAKE_MAX_ATTEMPTS = 3;

/**
 * Ponowienie nieudanego intake'u (failed → received): czyści błąd i pola etapów,
 * podbija attempts; wyczerpane próby → conflict. Poza failed → conflict.
 */
export function retryIntake(db: Db, id: string): IntakeRow {
  const tx = db.transaction(() => {
    const row = getIntakeOrThrow(db, id);
    if (row.status !== 'failed') {
      throw new AppError('conflict', `ponowić można tylko intake w stanie failed (jest: ${row.status})`);
    }
    if (row.attempts >= INTAKE_MAX_ATTEMPTS) {
      throw new AppError('conflict', `wyczerpane próby (${row.attempts}/${INTAKE_MAX_ATTEMPTS}) — zgłoś treść ponownie`);
    }
    db.prepare(
      `UPDATE intakes SET status = 'received', error = NULL, extract_provider = NULL,
         extract_quality = NULL, clean_profile = NULL, cleaned_chars = NULL,
         removed_ratio = NULL, analysis_json = NULL, attempts = attempts + 1,
         updated_at = ? WHERE id = ?`,
    ).run(nowIso(), id);
    return getIntakeOrThrow(db, id);
  });
  return tx.immediate();
}

/** Pola etapów pipeline'u nadpisywane przy przejściach statusu. */
export interface IntakePatch {
  status?: IntakeStatus;
  extract_provider?: string;
  extract_quality?: number;
  clean_profile?: string;
  cleaned_chars?: number;
  removed_ratio?: number;
  analysis_json?: string;
  draft_id?: string;
  error?: string;
}

const PATCHABLE_COLUMNS: readonly (keyof IntakePatch)[] = [
  'status',
  'extract_provider',
  'extract_quality',
  'clean_profile',
  'cleaned_chars',
  'removed_ratio',
  'analysis_json',
  'draft_id',
  'error',
];

export function updateIntake(db: Db, id: string, patch: IntakePatch): IntakeRow {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const col of PATCHABLE_COLUMNS) {
    const v = patch[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      values.push(v);
    }
  }
  if (sets.length === 0) return getIntakeOrThrow(db, id);
  sets.push('updated_at = ?');
  values.push(nowIso(), id);
  db.prepare(`UPDATE intakes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getIntakeOrThrow(db, id);
}

// ── Idempotency-Key (mapa w pamięci procesu — v1, jeden worker in-process) ──

const IDEMPOTENCY_MAX_ENTRIES = 1000;
const idempotencyMap = new Map<string, string>();

function idempotencyMapKey(userId: string, key: string): string {
  return `${userId} ${key}`;
}

/** intakeId zapamiętany dla (użytkownik, Idempotency-Key) albo null. */
export function recallIdempotency(userId: string, key: string): string | null {
  return idempotencyMap.get(idempotencyMapKey(userId, key)) ?? null;
}

export function rememberIdempotency(userId: string, key: string, intakeId: string): void {
  if (idempotencyMap.size >= IDEMPOTENCY_MAX_ENTRIES) {
    // Prosta ewikacja FIFO — mapa jest tylko wygodą (dedup po sha256 i tak działa).
    const oldest = idempotencyMap.keys().next().value;
    if (oldest !== undefined) idempotencyMap.delete(oldest);
  }
  idempotencyMap.set(idempotencyMapKey(userId, key), intakeId);
}

// ── Widoki API (statusy humanized — słownik PL w services/messages.ts) ──────

/** Etapy pipeline'u w kolejności (bez 'failed' — to stan końcowy błędu). */
const STAGE_ORDER: readonly string[] = INTAKE_STAGES.filter((s) => s !== 'failed');

export function intakeToListItem(row: IntakeRow): Record<string, unknown> {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    originalName: row.original_name,
    sourceUrl: row.source_url,
    status: row.status,
    statusHuman: humanize(row.status),
    draftId: row.draft_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Detal z listą etapów (reached/current) — stepper ludzkich etapów w /add. */
export function intakeToDetail(row: IntakeRow): Record<string, unknown> {
  const failedAt = row.status === 'failed';
  const reachedIdx = failedAt
    ? // failed: doszliśmy najdalej do etapu, którego pola są wypełnione
      row.analysis_json !== null
      ? 3
      : row.clean_profile !== null
        ? 2
        : row.extract_provider !== null
          ? 1
          : 0
    : STAGE_ORDER.indexOf(row.status);
  const stages = STAGE_ORDER.map((stage, i) => ({
    stage,
    ...humanize(stage),
    reached: i <= reachedIdx,
    current: !failedAt && i === reachedIdx,
  }));
  return {
    ...intakeToListItem(row),
    mime: row.mime,
    extractProvider: row.extract_provider,
    extractQuality: row.extract_quality,
    cleanProfile: row.clean_profile,
    cleanedChars: row.cleaned_chars,
    removedRatio: row.removed_ratio,
    analysis: row.analysis_json !== null ? (JSON.parse(row.analysis_json) as unknown) : null,
    errorHuman: row.error !== null ? humanize(row.error) : null,
    stages,
  };
}
