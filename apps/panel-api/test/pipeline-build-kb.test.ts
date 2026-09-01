import { afterAll, describe, expect, it } from 'vitest';
import {
  createDraft,
  getKbOrThrow,
  promoteDraft,
  transitionKb,
  type Db,
} from '@pomagierkb/shared/db';
import { OpenSpgClient } from '@pomagierkb/shared/openspg';
import type { FastifyInstance } from 'fastify';
import {
  fixture,
  jsonResponse,
  loginResponse,
  makeMockFetch,
  type RecordedCall,
} from '../../../packages/shared/test/helpers/openspg-mock.js';
import { buildApp } from '../src/app.js';
import { createKbEntry, finishProvisioning } from '../src/services/kb.js';
import { renderSchema } from '../src/services/schema-template.js';
import { runBuildKb } from '../src/jobs/build-kb.js';
import { JobFailure } from '../src/jobs/job-types.js';
import type { AppConfig } from '../src/config.js';
import type { AppUser } from '../src/types.js';
import { makeDb, makeKbTestConfig, seedEmbeddingsSettings, seedUser } from './helpers/kb.js';

/**
 * E2E akcji build_kb na MOCKU OpenSPG (fetchImpl): happy path (upload → submit
 * → FINISH per plik, dirty=0, quality gate OK), resume (drugi bieg pomija
 * upload i joby po sha256), force wymusza ponowny import, job ERROR → JobFailure
 * z ludzkim komunikatem PL. Plus trasa POST /kbs/:ns/build (422 preflight).
 */

interface BuilderMock {
  client: OpenSpgClient;
  calls: RecordedCall[];
  uploads: () => RecordedCall[];
  submits: () => { jobName: string; fileUrl: string }[];
}

/** Stanowy mock buildera: upload → URL MinIO, submit → jobId, get → status z opts. */
function makeBuilderMock(ns: string, opts: { jobStatus?: string } = {}): BuilderMock {
  let uploadCounter = 0;
  let jobCounter = 100;
  const jobs = new Map<number, { status: string; jobName: string; fileUrl: string }>();
  const submitted: { jobName: string; fileUrl: string }[] = [];

  const { impl, calls } = makeMockFetch((path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (path === '/v1/accounts/login') return loginResponse();
    if (path.startsWith('/v1/projects/list')) return jsonResponse(fixture('projects-list.json'));
    if (path.startsWith('/v1/schemas/graph/')) {
      const entityTypeDTOList = ['ConceptTaxonomy', 'Topic', 'ReferenceDocument', 'Chunk'].map((t, i) => ({
        id: 200 + i,
        name: `${ns}.${t}`,
        nameZh: t,
      }));
      return jsonResponse({ success: true, result: { entityTypeDTOList } });
    }
    if (path === '/public/v1/reasoner/dialog/uploadFile' && method === 'POST') {
      uploadCounter++;
      return jsonResponse({
        success: true,
        result: `http://release-openspg-minio:9000/builder/upload/f${uploadCounter}.csv`,
      });
    }
    if (path.startsWith('/public/v1/builder/job/list')) {
      return jsonResponse({ success: true, result: { data: [] } });
    }
    if (path === '/public/v1/builder/job/submit' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { jobName: string; fileUrl: string };
      submitted.push({ jobName: body.jobName, fileUrl: body.fileUrl });
      jobCounter++;
      jobs.set(jobCounter, { status: opts.jobStatus ?? 'FINISH', jobName: body.jobName, fileUrl: body.fileUrl });
      return jsonResponse({ success: true, result: jobCounter });
    }
    if (path.startsWith('/public/v1/builder/job/get')) {
      const id = Number(/[?&]id=(\d+)/.exec(path)?.[1]);
      const job = jobs.get(id)!;
      return jsonResponse({
        success: true,
        result: {
          id,
          status: job.status,
          jobName: job.jobName,
          fileUrl: job.fileUrl,
          gmtCreate: '2026-09-01 10:00:00',
          gmtModified: '2026-09-01 10:00:05',
        },
      });
    }
    if (path === '/public/v1/search/text' && method === 'POST') {
      return jsonResponse({ success: true, result: [{ docId: 'CHUNK_PROBE_000', score: 3.2, fields: {} }] });
    }
    throw new Error(`mock OpenSPG: nieoczekiwana ścieżka ${method} ${path}`);
  });

  const client = new OpenSpgClient({
    baseUrl: 'http://release-openspg-server:8887',
    account: 'openspg',
    password: 'openspg@kag',
    fetchImpl: impl,
  });
  return {
    client,
    calls,
    uploads: () => calls.filter((c) => c.path === '/public/v1/reasoner/dialog/uploadFile'),
    submits: () => submitted,
  };
}

/** KB active z projektem + zamrożonym modelem (jak po jobie create_kb). */
function provisionKb(db: Db, namespace: string, projectId: number): void {
  createKbEntry(db, { namespace, name: `Baza ${namespace}` });
  transitionKb(db, namespace, 'provisioning');
  finishProvisioning(db, namespace, {
    projectId,
    vectorModelId: 'inst1@text-embedding-3-small',
    hash: renderSchema(namespace).hash,
    content: renderSchema(namespace).content,
    createdBy: null,
  });
}

function seedPromotedDraft(db: Db, namespace: string, title: string, extra = ''): void {
  const draft = createDraft(db, {
    title,
    content: `# ${title}\n\nTreść dokumentu o oświetleniu awaryjnym. ${extra}`,
    sourceType: 'text',
    namespace,
    tags: ['Oświetlenie'],
    analysis: { summary: 'Krótki opis.', language: 'pl' },
  });
  promoteDraft(db, draft.id, 'u-test');
}

function buildDeps(db: Db, config: AppConfig, mock: BuilderMock, namespace: string, force = false) {
  return {
    db,
    config,
    client: mock.client,
    namespace,
    force,
    log: (): void => undefined,
    progress: (): void => undefined,
    pollMs: 1,
  };
}

const buildJobs = (db: Db, ns: string): { file_name: string; status: string; file_sha256: string }[] =>
  db
    .prepare('SELECT file_name, status, file_sha256 FROM build_jobs WHERE namespace = ? ORDER BY id')
    .all(ns) as { file_name: string; status: string; file_sha256: string }[];

describe('runBuildKb — E2E na mocku OpenSPG', () => {
  const db = makeDb();
  const config = makeKbTestConfig();
  const NS = 'BuildDocs';
  const mock = makeBuilderMock(NS);

  afterAll(() => db.close());

  it('happy path: uploady + joby FINISH per plik, dirty=0, quality gate OK', async () => {
    seedEmbeddingsSettings(db, config, 'text-embedding-3-small');
    provisionKb(db, NS, 4);
    seedPromotedDraft(db, NS, 'Dokument pierwszy');
    seedPromotedDraft(db, NS, 'Dokument drugi', 'Wariant B.');
    expect(getKbOrThrow(db, NS).dirty).toBe(1); // promocje brudzą bazę

    const result = await runBuildKb(buildDeps(db, config, mock, NS));

    expect(mock.uploads()).toHaveLength(3); // topic + reference_document + chunk
    // job_prefix z wielkich liter namespace: 'BuildDocs' → 'BD'.
    expect(mock.submits().map((s) => s.jobName)).toEqual([
      'BD Topic CSV Import',
      'BD ReferenceDocument CSV Import',
      'BD Chunk CSV Import',
    ]);
    const jobs = buildJobs(db, NS);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === 'FINISH')).toBe(true);
    expect(getKbOrThrow(db, NS).dirty).toBe(0);
    expect(result.report.verdict).toBe('OK');
    expect(result.report.checks).toHaveLength(10);
    expect(result.report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('resume: drugi bieg pomija uploady i joby (ta sama treść = ten sam sha256)', async () => {
    const uploadsBefore = mock.uploads().length;
    const submitsBefore = mock.submits().length;

    await runBuildKb(buildDeps(db, config, mock, NS));

    expect(mock.uploads()).toHaveLength(uploadsBefore); // zero nowych uploadów
    expect(mock.submits()).toHaveLength(submitsBefore); // zero nowych jobów
    expect(buildJobs(db, NS)).toHaveLength(3); // bez nowych wierszy build_jobs
  });

  it('force: wymusza ponowny upload i ponowne joby mimo niezmienionej treści', async () => {
    const uploadsBefore = mock.uploads().length;
    const submitsBefore = mock.submits().length;

    await runBuildKb(buildDeps(db, config, mock, NS, true));

    expect(mock.uploads()).toHaveLength(uploadsBefore + 3);
    expect(mock.submits()).toHaveLength(submitsBefore + 3);
    const jobs = buildJobs(db, NS);
    expect(jobs).toHaveLength(6); // 3 z pierwszego biegu + 3 z force
    expect(jobs.every((j) => j.status === 'FINISH')).toBe(true);
  });

  it('job ERROR → JobFailure z ludzkim komunikatem PL i zapisem statusu w build_jobs', async () => {
    const NS2 = 'BuildErrDocs';
    const errMock = makeBuilderMock(NS2, { jobStatus: 'ERROR' });
    provisionKb(db, NS2, 5); // FK: draft wymaga wpisu KB w rejestrze
    seedPromotedDraft(db, NS2, 'Dokument z błędem');

    const promise = runBuildKb(buildDeps(db, config, errMock, NS2));
    await expect(promise).rejects.toBeInstanceOf(JobFailure);
    await expect(promise).rejects.toThrowError(/błąd buildera/); // etykieta PL, nie surowy kod
    const jobs = buildJobs(db, NS2);
    expect(jobs).toHaveLength(1); // padło na pierwszym pliku (topic.csv)
    expect(jobs[0]!.status).toBe('ERROR');
  });

  it('preflight w jobie blokuje build bez promowanych draftów', async () => {
    const NS3 = 'BuildEmptyDocs';
    provisionKb(db, NS3, 6);
    const emptyMock = makeBuilderMock(NS3);
    await expect(runBuildKb(buildDeps(db, config, emptyMock, NS3))).rejects.toThrowError(
      /brak wypromowanych draftów/,
    );
  });
});

describe('trasa POST /kbs/:ns/build', () => {
  let app: FastifyInstance;
  let db: Db;
  let config: AppConfig;
  let operator: AppUser;

  it('422 preflight_failed z listą checks (OpenSPG nieosiągalny w środowisku testowym)', async () => {
    db = makeDb();
    config = makeKbTestConfig();
    operator = seedUser(db, 'u-operator', 'operator');
    seedEmbeddingsSettings(db, config, 'text-embedding-3-small');
    provisionKb(db, 'RouteBuildDocs', 21);
    seedPromotedDraft(db, 'RouteBuildDocs', 'Dokument trasy');
    app = await buildApp({ config, db });
    app.addHook('onRequest', async (req) => {
      req.user = operator;
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/kbs/RouteBuildDocs/build',
      payload: { force: false },
    });
    expect(res.statusCode).toBe(422);
    const { error } = res.json() as { error: { code: string; details: { checks: { id: string; ok: boolean }[] } } };
    expect(error.code).toBe('preflight_failed');
    const reachable = error.details.checks.find((c) => c.id === 'openspg_reachable');
    expect(reachable?.ok).toBe(false);
    // Twardy guard embeddingu przeszedł (model zgodny) — pada tylko sieć.
    expect(error.details.checks.find((c) => c.id === 'embedding_model')?.ok).toBe(true);

    await app.close();
    db.close();
  });
});
