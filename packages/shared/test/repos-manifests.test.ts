import { describe, expect, it } from 'vitest';
import {
  createKb,
  findActiveBuildJobs,
  findFinishedBuildJob,
  finishExportRun,
  getUploadRecord,
  latestExportRun,
  latestQualityReport,
  listExportFiles,
  recordBuildJob,
  saveQualityReport,
  saveUploadRecord,
  startExportRun,
  updateBuildJobStatus,
  upsertExportFile,
} from '../src/db/index.js';
import { testDb } from './helpers.js';

describe('repos/manifests', () => {
  it('export run start/finish + upsert plików', () => {
    const db = testDb();
    createKb(db, { namespace: 'LightingDocs', name: 'Oświetlenie' }); // FK export_runs → kb_registry
    const run = startExportRun(db, 'LightingDocs');
    expect(run.status).toBe('running');

    upsertExportFile(db, run.id, {
      fileName: 'chunks.csv',
      rowCount: 10,
      columns: ['id', 'content'],
      sha256: 'aaa',
      path: '/data/exports/LightingDocs/chunks.csv',
    });
    // upsert nadpisuje ten sam (run, plik)
    upsertExportFile(db, run.id, {
      fileName: 'chunks.csv',
      rowCount: 12,
      columns: ['id', 'content'],
      sha256: 'bbb',
      path: '/data/exports/LightingDocs/chunks.csv',
    });
    const files = listExportFiles(db, run.id);
    expect(files).toHaveLength(1);
    expect(files[0]?.row_count).toBe(12);
    expect(files[0]?.sha256).toBe('bbb');

    const done = finishExportRun(db, run.id, 'success', { docCount: 3, chunkCount: 12 });
    expect(done.status).toBe('success');
    expect(done.finished_at).toBeTruthy();
    expect(() => finishExportRun(db, run.id, 'error')).toThrowError(/running/);
    expect(latestExportRun(db, 'LightingDocs')?.id).toBe(run.id);
  });

  it('upload_records: klucz namespace+file+sha256 (cache uploadów)', () => {
    const db = testDb();
    expect(getUploadRecord(db, 'Ns', 'a.csv', 'h1')).toBeNull();
    saveUploadRecord(db, { namespace: 'Ns', fileName: 'a.csv', fileSha256: 'h1', uploadedUrl: 'http://u/1' });
    saveUploadRecord(db, { namespace: 'Ns', fileName: 'a.csv', fileSha256: 'h1', uploadedUrl: 'http://u/2' });
    expect(getUploadRecord(db, 'Ns', 'a.csv', 'h1')?.uploaded_url).toBe('http://u/2');
    expect(getUploadRecord(db, 'Ns', 'a.csv', 'h2')).toBeNull(); // inna treść → osobny wpis
  });

  it('build_jobs: resume po (namespace,file,sha256); statusy terminalne ustawiają finished_at', () => {
    const db = testDb();
    const job = recordBuildJob(db, {
      namespace: 'Ns',
      fileName: 'chunks.csv',
      fileSha256: 'h1',
      jobName: 'NS-chunks-1',
      entityType: 'Ns.Chunk',
    });
    expect(job.status).toBe('INIT');
    expect(findActiveBuildJobs(db, 'Ns')).toHaveLength(1);
    expect(findFinishedBuildJob(db, 'Ns', 'chunks.csv', 'h1')).toBeNull();

    updateBuildJobStatus(db, job.id, 'RUNNING', { openspgJobId: 4711 });
    updateBuildJobStatus(db, job.id, 'FINISH');
    const finished = findFinishedBuildJob(db, 'Ns', 'chunks.csv', 'h1');
    expect(finished?.openspg_job_id).toBe(4711);
    expect(finished?.finished_at).toBeTruthy();
    expect(findActiveBuildJobs(db, 'Ns')).toHaveLength(0);
    // inna zawartość pliku → brak trafienia resume
    expect(findFinishedBuildJob(db, 'Ns', 'chunks.csv', 'h2')).toBeNull();
  });

  it('quality_reports: save + latest', () => {
    const db = testDb();
    saveQualityReport(db, 'Ns', null, 'WARN', [{ id: 'coverage', ok: false }]);
    saveQualityReport(db, 'Ns', 1, 'OK', [{ id: 'coverage', ok: true }]);
    const latest = latestQualityReport(db, 'Ns');
    expect(latest?.verdict).toBe('OK');
    expect(JSON.parse(latest?.checks_json ?? '[]')[0].ok).toBe(true);
  });
});
