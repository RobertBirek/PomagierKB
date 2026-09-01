import type { Db } from '../open.js';
import { nowIso } from '../open.js';
import { AppError } from '../../errors.js';

/** Manifesty pipeline'u w DB (resume bez plików JSON): eksporty, uploady, buildy, quality. */

// --- export_runs ---------------------------------------------------------

export type ExportRunStatus = 'running' | 'success' | 'error';

export interface ExportRunRow {
  id: number;
  namespace: string;
  status: ExportRunStatus;
  doc_count: number | null;
  chunk_count: number | null;
  started_at: string;
  finished_at: string | null;
}

export function startExportRun(db: Db, namespace: string): ExportRunRow {
  const res = db
    .prepare("INSERT INTO export_runs (namespace, status, started_at) VALUES (?, 'running', ?)")
    .run(namespace, nowIso());
  return getExportRunOrThrow(db, Number(res.lastInsertRowid));
}

export function finishExportRun(
  db: Db,
  id: number,
  status: 'success' | 'error',
  counts: { docCount?: number; chunkCount?: number } = {},
): ExportRunRow {
  const tx = db.transaction(() => {
    const row = getExportRunOrThrow(db, id);
    if (row.status !== 'running') {
      throw new AppError('conflict', `export run nie jest running (status: ${row.status})`);
    }
    db.prepare(
      'UPDATE export_runs SET status = ?, doc_count = ?, chunk_count = ?, finished_at = ? WHERE id = ?',
    ).run(status, counts.docCount ?? row.doc_count, counts.chunkCount ?? row.chunk_count, nowIso(), id);
    return getExportRunOrThrow(db, id);
  });
  return tx.immediate();
}

export function getExportRun(db: Db, id: number): ExportRunRow | null {
  const row = db.prepare('SELECT * FROM export_runs WHERE id = ?').get(id) as ExportRunRow | undefined;
  return row ?? null;
}

function getExportRunOrThrow(db: Db, id: number): ExportRunRow {
  const row = getExportRun(db, id);
  if (!row) throw new AppError('not_found', `export run nie istnieje: ${id}`);
  return row;
}

export function latestExportRun(db: Db, namespace: string): ExportRunRow | null {
  const row = db
    .prepare('SELECT * FROM export_runs WHERE namespace = ? ORDER BY id DESC LIMIT 1')
    .get(namespace) as ExportRunRow | undefined;
  return row ?? null;
}

// --- export_files --------------------------------------------------------

export interface ExportFileRow {
  run_id: number;
  file_name: string;
  row_count: number;
  columns_json: string;
  sha256: string;
  path: string;
}

export function upsertExportFile(
  db: Db,
  runId: number,
  file: { fileName: string; rowCount: number; columns: string[]; sha256: string; path: string },
): void {
  db.prepare(
    `INSERT INTO export_files (run_id, file_name, row_count, columns_json, sha256, path)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, file_name) DO UPDATE SET row_count = excluded.row_count,
       columns_json = excluded.columns_json, sha256 = excluded.sha256, path = excluded.path`,
  ).run(runId, file.fileName, file.rowCount, JSON.stringify(file.columns), file.sha256, file.path);
}

export function listExportFiles(db: Db, runId: number): ExportFileRow[] {
  return db
    .prepare('SELECT * FROM export_files WHERE run_id = ? ORDER BY file_name')
    .all(runId) as ExportFileRow[];
}

// --- upload_records (cache uploadów; klucz = namespace+file+sha256 TREŚCI) ---

export interface UploadRecordRow {
  namespace: string;
  file_name: string;
  file_sha256: string;
  uploaded_url: string;
  uploaded_at: string;
}

export function getUploadRecord(
  db: Db,
  namespace: string,
  fileName: string,
  fileSha256: string,
): UploadRecordRow | null {
  const row = db
    .prepare('SELECT * FROM upload_records WHERE namespace = ? AND file_name = ? AND file_sha256 = ?')
    .get(namespace, fileName, fileSha256) as UploadRecordRow | undefined;
  return row ?? null;
}

export function saveUploadRecord(
  db: Db,
  rec: { namespace: string; fileName: string; fileSha256: string; uploadedUrl: string },
): void {
  db.prepare(
    `INSERT INTO upload_records (namespace, file_name, file_sha256, uploaded_url, uploaded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(namespace, file_name, file_sha256) DO UPDATE SET uploaded_url = excluded.uploaded_url,
       uploaded_at = excluded.uploaded_at`,
  ).run(rec.namespace, rec.fileName, rec.fileSha256, rec.uploadedUrl, nowIso());
}

// --- build_jobs ----------------------------------------------------------

/** Statusy buildera OpenSPG; terminalne kończą job (finished_at). */
export const BUILD_JOB_TERMINAL = ['FINISH', 'ERROR', 'SKIP', 'TERMINATE', 'SET_FINISH'] as const;

export interface BuildJobRow {
  id: number;
  namespace: string;
  run_id: number | null;
  file_name: string;
  file_sha256: string;
  openspg_job_id: number | null;
  job_name: string;
  entity_type: string;
  entity_type_id: number | null;
  row_count: number | null;
  uploaded_url: string | null;
  status: string;
  gmt_create: string | null;
  gmt_modified: string | null;
  finished_at: string | null;
}

export interface BuildJobInput {
  namespace: string;
  runId?: number | null;
  fileName: string;
  fileSha256: string;
  openspgJobId?: number | null;
  jobName: string;
  entityType: string;
  entityTypeId?: number | null;
  rowCount?: number | null;
  uploadedUrl?: string | null;
  status?: string;
}

export function recordBuildJob(db: Db, input: BuildJobInput): BuildJobRow {
  const res = db
    .prepare(
      `INSERT INTO build_jobs (namespace, run_id, file_name, file_sha256, openspg_job_id, job_name,
         entity_type, entity_type_id, row_count, uploaded_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.namespace,
      input.runId ?? null,
      input.fileName,
      input.fileSha256,
      input.openspgJobId ?? null,
      input.jobName,
      input.entityType,
      input.entityTypeId ?? null,
      input.rowCount ?? null,
      input.uploadedUrl ?? null,
      input.status ?? 'INIT',
    );
  return db.prepare('SELECT * FROM build_jobs WHERE id = ?').get(Number(res.lastInsertRowid)) as BuildJobRow;
}

export function updateBuildJobStatus(
  db: Db,
  id: number,
  status: string,
  meta: { openspgJobId?: number; gmtCreate?: string; gmtModified?: string } = {},
): void {
  const terminal = (BUILD_JOB_TERMINAL as readonly string[]).includes(status);
  const res = db
    .prepare(
      `UPDATE build_jobs SET status = ?,
         openspg_job_id = COALESCE(?, openspg_job_id),
         gmt_create = COALESCE(?, gmt_create),
         gmt_modified = COALESCE(?, gmt_modified),
         finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END
       WHERE id = ?`,
    )
    .run(
      status,
      meta.openspgJobId ?? null,
      meta.gmtCreate ?? null,
      meta.gmtModified ?? null,
      terminal ? 1 : 0,
      nowIso(),
      id,
    );
  if (res.changes === 0) throw new AppError('not_found', `build job nie istnieje: ${id}`);
}

/** Resume: czy plik o tej treści został już zbudowany (FINISH/SET_FINISH)? */
export function findFinishedBuildJob(
  db: Db,
  namespace: string,
  fileName: string,
  fileSha256: string,
): BuildJobRow | null {
  const row = db
    .prepare(
      `SELECT * FROM build_jobs
       WHERE namespace = ? AND file_name = ? AND file_sha256 = ? AND status IN ('FINISH','SET_FINISH')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(namespace, fileName, fileSha256) as BuildJobRow | undefined;
  return row ?? null;
}

/** Joby w toku (INIT/WAITING/RUNNING) — guard preflight buildu. */
export function findActiveBuildJobs(db: Db, namespace: string): BuildJobRow[] {
  return db
    .prepare(
      "SELECT * FROM build_jobs WHERE namespace = ? AND status IN ('INIT','WAITING','RUNNING') ORDER BY id",
    )
    .all(namespace) as BuildJobRow[];
}

// --- quality_reports -----------------------------------------------------

export type QualityVerdict = 'OK' | 'WARN' | 'FAIL';

export interface QualityReportRow {
  id: number;
  namespace: string;
  run_id: number | null;
  verdict: QualityVerdict;
  checks_json: string;
  created_at: string;
}

export function saveQualityReport(
  db: Db,
  namespace: string,
  runId: number | null,
  verdict: QualityVerdict,
  checks: unknown[],
): QualityReportRow {
  const res = db
    .prepare(
      'INSERT INTO quality_reports (namespace, run_id, verdict, checks_json, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(namespace, runId, verdict, JSON.stringify(checks), nowIso());
  return db
    .prepare('SELECT * FROM quality_reports WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as QualityReportRow;
}

export function latestQualityReport(db: Db, namespace: string): QualityReportRow | null {
  const row = db
    .prepare('SELECT * FROM quality_reports WHERE namespace = ? ORDER BY id DESC LIMIT 1')
    .get(namespace) as QualityReportRow | undefined;
  return row ?? null;
}
