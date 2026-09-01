import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenSpgClient } from '../src/openspg/client.js';
import {
  buildCsvUpsertJobPayload, getJob, isReusableActiveJob, listJobs, submitCsvUpsertJob,
  uploadFile, waitForJob, type BuilderJob,
} from '../src/openspg/builder.js';
import { AppError } from '../src/errors.js';
import { fixture, jsonResponse, loginResponse, makeMockFetch, type MockHandler } from './helpers/openspg-mock.js';

function makeClient(handler: MockHandler) {
  const { impl, calls } = makeMockFetch((path, init, call) => {
    if (path === '/v1/accounts/login') return loginResponse();
    return handler(path, init, call);
  });
  const client = new OpenSpgClient({
    baseUrl: 'http://release-openspg-server:8887',
    account: 'openspg',
    password: 'openspg@kag',
    fetchImpl: impl,
  });
  return { client, calls };
}

const submitParams = {
  projectId: 3,
  createUser: 'openspg',
  jobName: 'LDOC Chunk CSV Import',
  fileUrl: 'http://release-openspg-minio:9000/builder/upload/20260901/chunk.csv',
  fileName: 'chunk.csv',
  columns: ['id', 'name', 'content'],
  entityLongName: 'LightingDocs.Chunk',
  entityShortName: 'Chunk',
  entityTypeId: 118,
};

describe('builder', () => {
  it('uploadFile wysyła multipart z polem file i zwraca URL z result', async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({ success: true, result: 'http://release-openspg-minio:9000/builder/upload/20260901/chunk.csv' }));
    const url = await uploadFile(client, { name: 'chunk.csv', content: 'id,name,content\n1,a,b\n' });
    expect(url).toBe('http://release-openspg-minio:9000/builder/upload/20260901/chunk.csv');
    const body = calls[1]!.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const file = (body as FormData).get('file');
    expect(file).toBeInstanceOf(Blob);
  });

  it('payload submitCsvUpsertJob — snapshot dokładnej struktury (extension jako zserializowany JSON)', async () => {
    const payload = buildCsvUpsertJobPayload(submitParams);
    expect(typeof payload['extension']).toBe('string');
    const { extension, ...rest } = payload as Record<string, unknown> & { extension: string };
    expect(rest).toEqual({
      projectId: 3,
      createUser: 'openspg',
      jobName: 'LDOC Chunk CSV Import',
      type: 'FILE_EXTRACT',
      dataSourceType: 'CSV',
      fileUrl: 'http://release-openspg-minio:9000/builder/upload/20260901/chunk.csv',
      lifeCycle: 'ONCE',
      action: 'UPSERT',
    });
    expect(JSON.parse(extension)).toEqual({
      dataSourceConfig: {
        columns: [
          { name: 'id', index: 0 },
          { name: 'name', index: 1 },
          { name: 'content', index: 2 },
        ],
        type: 'UPLOAD',
        fileName: 'chunk.csv',
        fileUrl: 'http://release-openspg-minio:9000/builder/upload/20260901/chunk.csv',
        ignoreHeader: true,
        structure: true,
      },
      mappingConfig: {
        mappingType: 'entityMapping',
        filter: [{
          s: 'LightingDocs.Chunk',
          sId: 118,
          sZhName: 'Chunk',
          importSchemaCategory: 'ENTITY',
        }],
        config: [{
          mapping: { id: ['id'], name: ['name'], content: ['content'] },
          name: 'Chunk(LightingDocs.Chunk)',
          id: '1',
        }],
      },
    });
  });

  it('submitCsvUpsertJob POSTuje dokładnie ten payload i zwraca jobId', async () => {
    const { client, calls } = makeClient(() => jsonResponse({ success: true, result: 4711 }));
    const jobId = await submitCsvUpsertJob(client, submitParams);
    expect(jobId).toBe(4711);
    expect(calls[1]!.path).toBe('/public/v1/builder/job/submit');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual(buildCsvUpsertJobPayload(submitParams));
  });

  it('listJobs wymusza start=1 (start=0 to bug SQL) i normalizuje result.data', async () => {
    const { client, calls } = makeClient(() => jsonResponse(fixture('builder-job-list.json')));
    const jobs = await listJobs(client, 3, { start: 0, limit: 100 });
    expect(calls[1]!.path).toBe('/public/v1/builder/job/list?projectId=3&start=1&limit=100');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.id).toBe(4711);
  });

  it('listJobs bez opcji: start=1, limit=100', async () => {
    const { client, calls } = makeClient(() => jsonResponse(fixture('builder-job-list.json')));
    await listJobs(client, 3);
    expect(calls[1]!.path).toBe('/public/v1/builder/job/list?projectId=3&start=1&limit=100');
  });

  it('getJob zwraca joba z result', async () => {
    const { client } = makeClient(() => jsonResponse(fixture('builder-job-get-running.json')));
    const job = await getJob(client, 4711);
    expect(job.status).toBe('RUNNING');
    expect(job.jobName).toBe('LDOC Chunk CSV Import');
  });

  describe('waitForJob (fake timers)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('kończy na statusie terminalnym FINISH i woła onTick dla aktywnych', async () => {
      let gets = 0;
      const { client } = makeClient(() => {
        gets += 1;
        return jsonResponse(fixture(gets < 3 ? 'builder-job-get-running.json' : 'builder-job-get-finish.json'));
      });
      const ticks: string[] = [];
      const promise = waitForJob(client, 4711, {
        pollMs: 3000,
        onTick: (job) => ticks.push(String(job.status)),
      });
      await vi.advanceTimersByTimeAsync(6000);
      const job = await promise;
      expect(job.status).toBe('FINISH');
      expect(gets).toBe(3);
      expect(ticks).toEqual(['RUNNING', 'RUNNING']);
    });

    it('rzuca upstream_timeout gdy job nie kończy się w timeoutMs', async () => {
      const { client } = makeClient(() => jsonResponse(fixture('builder-job-get-running.json')));
      const promise = waitForJob(client, 4711, { pollMs: 3000, timeoutMs: 9000 });
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'AppError',
        code: 'upstream_timeout',
      });
      await vi.advanceTimersByTimeAsync(9000);
      await assertion;
      await expect(promise).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('isReusableActiveJob', () => {
    const base: BuilderJob = {
      id: 4711,
      jobName: 'LDOC Chunk CSV Import',
      fileUrl: 'http://minio/chunk.csv',
      status: 'RUNNING',
    };
    const match = { jobName: 'LDOC Chunk CSV Import', fileUrl: 'http://minio/chunk.csv' };

    it('zwraca aktywnego joba o zgodnych (jobName, fileUrl) młodszego niż maxAgeMs', () => {
      const jobs: BuilderJob[] = [
        { ...base, gmtCreate: new Date(Date.now() - 10 * 60_000).toISOString() },
      ];
      expect(isReusableActiveJob(jobs, match)?.id).toBe(4711);
    });

    it('odrzuca joba starszego niż 45 min, terminalnego i o innym fileUrl', () => {
      const fresh = new Date(Date.now() - 10 * 60_000).toISOString();
      const stale = new Date(Date.now() - 46 * 60_000).toISOString();
      expect(isReusableActiveJob([{ ...base, gmtCreate: stale }], match)).toBeUndefined();
      expect(isReusableActiveJob([{ ...base, status: 'FINISH', gmtCreate: fresh }], match)).toBeUndefined();
      expect(isReusableActiveJob([{ ...base, fileUrl: 'http://minio/other.csv', gmtCreate: fresh }], match)).toBeUndefined();
      // brak daty utworzenia = nie do przejęcia (nie wiemy, czy nie wisi od godzin)
      expect(isReusableActiveJob([{ ...base }], match)).toBeUndefined();
    });
  });
});
