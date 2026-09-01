import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  getKbOrThrow,
  openDb,
  runMigrations,
  transitionKb,
  type Db,
} from '@pomagierkb/shared/db';
import { OpenSpgClient } from '@pomagierkb/shared/openspg';
import {
  fixture,
  jsonResponse,
  loginResponse,
  makeMockFetch,
  type RecordedCall,
} from '../../../packages/shared/test/helpers/openspg-mock.js';
import { buildApp } from '../src/app.js';
import { makeTestConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import { finishProvisioning } from '../src/services/kb.js';
import { renderSchema } from '../src/services/schema-template.js';
import { runBuildKb } from '../src/jobs/build-kb.js';
import { tickIntakeWorker } from '../src/pipeline/intake-worker.js';
import { startMockOidc, performLogin, type MockOidc } from './helpers/oidc-mock.js';

/**
 * E2E PEŁNEGO CYKLU WIEDZY na mockach (PLAN Faza 4) — jedna instancja aplikacji,
 * jeden użytkownik (pełny login OIDC przez mock IdP), jeden wątek zdarzeń:
 *
 *   login → POST /kbs (rejestr) → mock provisioning (finishProvisioning: projekt
 *   + zamrożony model embeddingów) → PUT /settings llm.chat+llm.embeddings (mock
 *   HTTP LLM) → POST /content (tekst PL) → intake worker (offline: raw→clean→
 *   heurystyczny analyze) → draft pending w Inboxie → promote (dirty=1) →
 *   runBuildKb na MOCKU OpenSPG (upload+submit+FINISH per plik, quality gate OK,
 *   dirty=0, chunks_mirror zapełniony) → POST /api/v1/ask (SSE; OpenSPG celowo
 *   nieosiągalny → FTS5 fallback, degraded:true; mock chat cytuje [1]) →
 *   feedback 'down' → luka wiedzy widoczna w GET /learning/gaps.
 *
 * OpenSPG buildera = mock fetchImpl (jak pipeline-build-kb.test.ts); OpenSPG
 * retrievalu = 127.0.0.1:1 (ECONNREFUSED → uczciwie degraded). Zero sieci.
 */

const NS = 'CycleDocs';

const TEXT =
  'Oświetlenie awaryjne w halach przemysłowych montuje się nad drogami ewakuacyjnymi. ' +
  'Natężenie oświetlenia awaryjnego na osi drogi ewakuacyjnej nie może być mniejsze ' +
  'niż jeden luks, a czas działania oświetlenia po zaniku napięcia wynosi co najmniej godzinę.';

// Pytanie sklejone ze słów TREŚCI (FTS5 trigram + stemy AND — patrz buildMatchExpression).
const QUESTION = 'Natężenie oświetlenia awaryjnego na osi drogi ewakuacyjnej?';

const CHAT_TEXT =
  'Zgodnie ze źródłem [1] natężenie oświetlenia awaryjnego na osi drogi ewakuacyjnej ' +
  'wynosi co najmniej jeden luks.\nCONFIDENCE: 0.85';

// ── mock HTTP LLM (OpenAI-compatible; embeddings celowo 404 → kanał wektorowy pada) ──

interface MockLlm {
  baseUrl: string;
  chatCalls: () => number;
  close: () => Promise<void>;
}

async function startMockLlm(): Promise<MockLlm> {
  let chatCalls = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      chatCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-cycle',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'chat-cycle',
          choices: [
            { index: 0, message: { role: 'assistant', content: CHAT_TEXT }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock LLM: nieoczekiwana ścieżka ${req.url}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    chatCalls: () => chatCalls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ── stanowy mock buildera OpenSPG (wzorzec z pipeline-build-kb.test.ts) ─────

interface BuilderMock {
  client: OpenSpgClient;
  uploads: () => RecordedCall[];
  submits: () => { jobName: string; fileUrl: string }[];
}

function makeBuilderMock(ns: string): BuilderMock {
  let uploadCounter = 0;
  let jobCounter = 500;
  const jobs = new Map<number, { status: string; jobName: string; fileUrl: string }>();
  const submitted: { jobName: string; fileUrl: string }[] = [];

  const { impl, calls } = makeMockFetch((path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (path === '/v1/accounts/login') return loginResponse();
    if (path.startsWith('/v1/projects/list')) return jsonResponse(fixture('projects-list.json'));
    if (path.startsWith('/v1/schemas/graph/')) {
      const entityTypeDTOList = ['ConceptTaxonomy', 'Topic', 'ReferenceDocument', 'Chunk'].map((t, i) => ({
        id: 300 + i,
        name: `${ns}.${t}`,
        nameZh: t,
      }));
      return jsonResponse({ success: true, result: { entityTypeDTOList } });
    }
    if (path === '/public/v1/reasoner/dialog/uploadFile' && method === 'POST') {
      uploadCounter++;
      return jsonResponse({
        success: true,
        result: `http://release-openspg-minio:9000/builder/upload/cycle${uploadCounter}.csv`,
      });
    }
    if (path.startsWith('/public/v1/builder/job/list')) {
      return jsonResponse({ success: true, result: { data: [] } });
    }
    if (path === '/public/v1/builder/job/submit' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { jobName: string; fileUrl: string };
      submitted.push({ jobName: body.jobName, fileUrl: body.fileUrl });
      jobCounter++;
      jobs.set(jobCounter, { status: 'FINISH', jobName: body.jobName, fileUrl: body.fileUrl });
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
  void calls;

  const client = new OpenSpgClient({
    baseUrl: 'http://release-openspg-server:8887',
    account: 'openspg',
    password: 'openspg@kag',
    fetchImpl: impl,
  });
  return {
    client,
    uploads: () => calls.filter((c) => c.path === '/public/v1/reasoner/dialog/uploadFile'),
    submits: () => submitted,
  };
}

function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of text.split('\n\n')) {
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (eventLine === undefined || dataLine === undefined) continue;
    events.push({
      event: eventLine.slice(7),
      data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
    });
  }
  return events;
}

// Worker offline: bez sieci (fetchImpl rzuca) i bez LLM (heurystyczny analyze).
const offlineWorkerDeps = {
  chatLlm: null,
  openieLlm: null,
  aiClean: false,
  fetchImpl: (async () => {
    throw new Error('test offline: HTTP w workerze zabronione');
  }) as typeof globalThis.fetch,
};

let oidc: MockOidc;
let llm: MockLlm;
let app: FastifyInstance;
let db: Db;
let dataDir: string;
let sid = '';

// Stan przenoszony między krokami cyklu (testy biegną sekwencyjnie w pliku).
let intakeId = '';
let draftId = '';
let answerId = '';

function cookies(): Record<string, string> {
  return { kag_sid: sid };
}

beforeAll(async () => {
  oidc = await startMockOidc();
  llm = await startMockLlm();
  dataDir = mkdtempSync(join(tmpdir(), 'pomagierkb-cycle-'));
  db = openDb(join(dataDir, 'db', 'kag.db'));
  runMigrations(db, sharedMigrationsDir());
  app = await buildApp({
    config: makeTestConfig({
      dataDir,
      oidc: { issuer: oidc.issuer, clientId: 'kag-panel', clientSecret: 'test-client-secret' },
      // OpenSPG retrievalu NIEOSIĄGALNY (port 1 → ECONNREFUSED): /ask uczciwie
      // degraduje się do FTS5. Builder dostaje osobny mock fetchImpl (wyżej).
      openspg: { baseUrl: 'http://127.0.0.1:1', account: 'openspg', password: 'x' },
      rateLimits: { global: 10_000, auth: 1_000, mutation: 1_000 },
    }),
    db,
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  db.close();
  await llm.close();
  await oidc.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('E2E pełny cykl wiedzy: login → KB → content → inbox → build → ask → luka', () => {
  it('1. pełny login OIDC (mock IdP) → sesja admina', async () => {
    oidc.state.groups = ['kag-admin'];
    const { cbRes, sid: gotSid } = await performLogin(app, oidc, { returnTo: '/panel' });
    expect(cbRes.statusCode).toBe(302);
    expect(gotSid).not.toBe('');
    sid = gotSid;

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: cookies() });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { data: { user: { role: string } } }).data.user.role).toBe('admin');
  });

  it('2. POST /kbs + mock provisioning → baza active z zamrożonym modelem embeddingów', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/kbs',
      cookies: cookies(),
      payload: {
        namespace: NS,
        name: 'Baza cyklu wiedzy',
        documentTypes: [{ name: 'Instrukcja' }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { kb: { status: string } } }).data.kb.status).toBe('draft');

    // Mock provisioningu (jak job create_kb, bez sieci): projekt + schemat + model.
    transitionKb(db, NS, 'provisioning');
    const schema = renderSchema(NS);
    finishProvisioning(db, NS, {
      projectId: 7,
      vectorModelId: 'inst1@text-embedding-3-small',
      hash: schema.hash,
      content: schema.content,
      createdBy: null,
    });
    // Routing keywords dla heurystyki analyze (v1: kolumna rejestru, poza API create).
    db.prepare('UPDATE kb_registry SET routing_keywords = ? WHERE namespace = ?').run(
      JSON.stringify(['oświetlenie', 'luks']),
      NS,
    );

    const detail = await app.inject({ method: 'GET', url: `/api/v1/kbs/${NS}`, cookies: cookies() });
    expect(detail.statusCode).toBe(200);
    const kb = (detail.json() as { data: { kb: { status: string; vectorModelId: string } } }).data.kb;
    expect(kb.status).toBe('active');
    expect(kb.vectorModelId).toBe('inst1@text-embedding-3-small');
  });

  it('3. PUT /settings: llm.chat i llm.embeddings (mock HTTP LLM), sekret nie wraca', async () => {
    for (const [key, model] of [
      ['llm.chat', 'chat-cycle'],
      ['llm.embeddings', 'text-embedding-3-small'],
    ] as const) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/settings/${key}`,
        cookies: cookies(),
        payload: { value: { baseUrl: llm.baseUrl, model, apiKey: 'sk-cycle-tajny-999' } }, // gitleaks:allow — zmyślony sekret testowy
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('sk-cycle-tajny-999');
    }
  });

  it('4. POST /content (tekst PL) → 202 {intakeId, status received}', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      cookies: cookies(),
      headers: { 'content-type': 'application/json' },
      payload: { text: TEXT, title: 'Notatka o oświetleniu awaryjnym' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { ok: true; data: { intakeId: string; status: string } };
    expect(body.data.status).toBe('received');
    intakeId = body.data.intakeId;
    expect(intakeId).toMatch(/^intake_\d{8}_[0-9a-f]{8}$/);
  });

  it('5. intake worker (offline) → drafted; draft pending w Inboxie, routing do CycleDocs', async () => {
    const processed = await tickIntakeWorker(db, app.config, offlineWorkerDeps);
    expect(processed).toBeGreaterThanOrEqual(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/content/${intakeId}`,
      cookies: cookies(),
    });
    expect(detail.statusCode).toBe(200);
    const intake = (detail.json() as {
      data: { intake: { status: string; draftId: string | null; stages: { reached: boolean }[] } };
    }).data.intake;
    expect(intake.status).toBe('drafted');
    expect(intake.draftId).not.toBeNull();
    expect(intake.stages.every((s) => s.reached)).toBe(true);
    draftId = intake.draftId!;

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/drafts?status=pending',
      cookies: cookies(),
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as {
      data: { items: { id: string; namespace: string | null; status: string }[] };
    }).data.items;
    const mine = items.find((d) => d.id === draftId);
    expect(mine).toBeDefined();
    expect(mine!.namespace).toBe(NS); // heurystyka routingu po keywordach
  });

  it('6. POST /drafts/:id/promote → promoted, baza brudna (dirty=1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${draftId}/promote`,
      cookies: cookies(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { draft: { status: string } } };
    expect(body.data.draft.status).toBe('promoted');
    expect(getKbOrThrow(db, NS).dirty).toBe(1);
  });

  it('7. build_kb na mocku OpenSPG: uploady + joby FINISH, quality gate OK, chunks_mirror pełny', async () => {
    const mock = makeBuilderMock(NS);
    const result = await runBuildKb({
      db,
      config: app.config,
      client: mock.client,
      namespace: NS,
      log: () => undefined,
      progress: () => undefined,
      pollMs: 1,
    });

    expect(mock.uploads()).toHaveLength(3); // topic + reference_document + chunk
    expect(mock.submits().map((s) => s.jobName)).toEqual([
      'CD Topic CSV Import',
      'CD ReferenceDocument CSV Import',
      'CD Chunk CSV Import',
    ]);
    const jobs = db
      .prepare('SELECT status FROM build_jobs WHERE namespace = ?')
      .all(NS) as { status: string }[];
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === 'FINISH')).toBe(true);

    expect(getKbOrThrow(db, NS).dirty).toBe(0);
    expect(result.report.verdict).toBe('OK');
    expect(result.report.checks.filter((c) => !c.ok)).toEqual([]);

    const mirror = db
      .prepare('SELECT COUNT(*) AS n FROM chunks_mirror WHERE namespace = ?')
      .get(NS) as { n: number };
    expect(mirror.n).toBeGreaterThan(0); // FTS fallback ma z czego szukać
  });

  it('8. POST /ask (SSE) znajduje treść: FTS fallback, degraded:true, cytowanie [1]', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      cookies: cookies(),
      payload: { question: QUESTION, namespaces: [NS] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.body);
    const phases = events.filter((e) => e.event === 'status').map((e) => e.data['phase']);
    expect(phases).toEqual(['retrieval', 'generating']);
    expect(events.filter((e) => e.event === 'error')).toEqual([]);

    const result = events.find((e) => e.event === 'result')!.data as {
      answer: string;
      citations: { n: number; id: string; namespace: string }[];
      confidence: number;
      noAnswer: boolean;
      degraded: boolean;
      answerId: string;
    };
    expect(result.noAnswer).toBe(false);
    expect(result.degraded).toBe(true); // OpenSPG leży → tylko FTS5
    expect(result.answer).toContain('luks');
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0]!.namespace).toBe(NS);
    expect(llm.chatCalls()).toBe(1); // dokładnie jeden strzał do chat_llm
    answerId = result.answerId;
    expect(answerId).not.toBe('');
  });

  it('9. feedback down → luka wiedzy widoczna w GET /learning/gaps', async () => {
    const fb = await app.inject({
      method: 'POST',
      url: `/api/v1/ask/${answerId}/feedback`,
      cookies: cookies(),
      payload: { verdict: 'down', comment: 'Za mało szczegółów o czasie działania.' },
    });
    expect(fb.statusCode).toBe(201);
    const fbBody = fb.json() as { data: { gapRecorded: boolean; gapId?: string } };
    expect(fbBody.data.gapRecorded).toBe(true);
    expect(fbBody.data.gapId).toBeDefined();

    const gaps = await app.inject({
      method: 'GET',
      url: '/api/v1/learning/gaps?status=open',
      cookies: cookies(),
    });
    expect(gaps.statusCode).toBe(200);
    const items = (gaps.json() as {
      data: { items: { id: string; question: string; status: string }[] };
    }).data.items;
    const gap = items.find((g) => g.id === fbBody.data.gapId);
    expect(gap).toBeDefined();
    expect(gap!.question).toBe(QUESTION);
    expect(gap!.status).toBe('open');
  });
});
