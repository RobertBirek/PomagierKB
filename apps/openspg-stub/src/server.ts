import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { csvToObjects } from './csv.js';
import { parseMultipart } from './multipart.js';
import type { JobStatus, StubJob, StubState } from './state.js';
import { loadState, parseEntityTypes, persistState } from './state.js';

/**
 * Stub serwera OpenSPG 0.8 do developmentu bez pełnego stacka (Java+MySQL+
 * Neo4j+MinIO). Emuluje endpointy używane przez packages/shared/openspg,
 * zachowując kopertę {success:true, result:...}. Kształty odpowiedzi są
 * best-effort wg .claude/skills/openspg-api/SKILL.md — nie traktować jako
 * źródła prawdy o prawdziwym serwerze.
 */

export interface StubServerOptions {
  /** Czas przejścia joba INIT→RUNNING→FINISH w ms (env STUB_JOB_MS, default 2000). */
  jobMs?: number;
  /** Plik persystencji stanu (env STUB_STATE_FILE); brak = tylko pamięć. */
  stateFile?: string;
  /** Katalog na wgrane pliki (env STUB_UPLOAD_DIR; default w tmp). */
  uploadDir?: string;
  logger?: boolean;
}

const ok = (result: unknown): { success: true; result: unknown } => ({ success: true, result });
const fail = (errorMsg: string): { success: false; errorMsg: string } => ({ success: false, errorMsg });

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function jobDto(job: StubJob): Record<string, unknown> {
  return {
    id: job.id,
    projectId: job.projectId,
    jobName: job.jobName,
    fileUrl: job.fileUrl,
    status: job.status,
    createUser: job.createUser,
    type: job.type,
    dataSourceType: job.dataSourceType,
    lifeCycle: 'ONCE',
    action: 'UPSERT',
    extension: job.extension,
    gmtCreate: new Date(job.submittedAt).toISOString(),
  };
}

export function buildServer(opts: StubServerOptions = {}): FastifyInstance {
  const jobMs = opts.jobMs ?? (Number(process.env['STUB_JOB_MS'] ?? '') || 2000);
  const stateFile = opts.stateFile ?? process.env['STUB_STATE_FILE'];
  const uploadDir =
    opts.uploadDir ?? process.env['STUB_UPLOAD_DIR'] ?? join(tmpdir(), 'openspg-stub-uploads');

  const state: StubState = loadState(stateFile);
  const persist = (): void => persistState(stateFile, state);

  /** Po FINISH parsujemy wgrany CSV chunków i trzymamy wiersze w pamięci do search. */
  function ingestJob(job: StubJob): void {
    const upload = state.uploads.find((u) => u.url === job.fileUrl);
    if (!upload) return;
    let text: string;
    try {
      text = readFileSync(upload.path, 'utf8');
    } catch {
      return; // plik zniknął (restart bez wolumenu) — job kończy się bez danych
    }
    const project = state.projects.find((p) => p.id === job.projectId);
    const label = job.label !== '' ? job.label : `${project?.namespace ?? 'Unknown'}.Chunk`;
    csvToObjects(text).forEach((row, idx) => {
      const id = row['id'] !== undefined && row['id'] !== '' ? row['id'] : `${label}:${job.id}:${idx}`;
      const chunk = {
        id,
        name: row['name'] ?? '',
        content: row['content'] ?? row['description'] ?? '',
        label,
        properties: row,
      };
      const existing = state.chunks.findIndex((c) => c.id === id);
      if (existing >= 0) state.chunks[existing] = chunk; // action=UPSERT
      else state.chunks.push(chunk);
    });
  }

  /** Status joba wynika z upływu czasu od submitu (deterministycznie, bez timerów). */
  function refreshJobs(): void {
    const now = Date.now();
    let changed = false;
    for (const job of state.jobs) {
      if (job.status === 'FINISH' || job.status === 'ERROR') continue;
      const elapsed = now - job.submittedAt;
      let next: JobStatus = job.status;
      if (elapsed >= jobMs) next = job.shouldFail ? 'ERROR' : 'FINISH';
      else if (elapsed >= jobMs / 3) next = 'RUNNING';
      if (next !== job.status) {
        job.status = next;
        changed = true;
      }
      if (job.status === 'FINISH' && !job.ingested) {
        ingestJob(job);
        job.ingested = true;
        changed = true;
      }
    }
    if (changed) persist();
  }

  const app = Fastify({
    logger: opts.logger ?? false,
    // prawdziwy serwer ma trasy typu /v1/model/list/ (końcowy slash)
    routerOptions: { ignoreTrailingSlash: true },
    bodyLimit: 32 * 1024 * 1024,
  });

  // multipart trzymamy jako surowy Buffer i parsujemy sami (bez zależności)
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // --- healthcheck stubu (nie ma odpowiednika w prawdziwym OpenSPG) ---
  app.get('/healthz', () => ({ ok: true }));

  // --- login produktowy: zwraca Set-Cookie jak prawdziwy serwer ---
  app.post('/v1/accounts/login', (req, reply) => {
    const body = asRecord(req.body);
    const account = str(body['account']) || 'openspg';
    // hasło przychodzi jako sha256(password + "OPENSPG") — stub nie weryfikuje
    const token = createHash('sha256').update(`${account}:${Date.now()}:${randomBytes(8).toString('hex')}`)
      .digest('hex')
      .slice(0, 32);
    reply.header('set-cookie', [
      `OPENSPG_SESSION=${token}; Path=/; HttpOnly`,
      `OPENSPG_USER=${account}; Path=/`,
    ]);
    return ok({ account, token });
  });

  // --- projekty ---
  app.get('/v1/projects/list', (req) => {
    const q = req.query as Record<string, string | undefined>;
    const keyword = (q['keyword'] ?? '').toLowerCase();
    const data = state.projects.filter(
      (p) =>
        keyword === '' ||
        p.namespace.toLowerCase().includes(keyword) ||
        p.name.toLowerCase().includes(keyword),
    );
    return ok({ pageNo: 1, pageSize: Math.max(data.length, 10), total: data.length, data });
  });

  app.post('/v1/projects', (req) => {
    const b = asRecord(req.body);
    const namespace = str(b['namespace']);
    if (namespace === '') return fail('namespace is required');
    if (state.projects.some((p) => p.namespace === namespace)) {
      return fail(`namespace ${namespace} already exists`);
    }
    const project = {
      id: state.nextProjectId++,
      name: str(b['name']) || namespace,
      namespace,
      description: str(b['description']),
      config: asRecord(b['config']),
      createTime: new Date().toISOString(),
    };
    state.projects.push(project);
    persist();
    return ok(project.id); // prawdziwy serwer zwraca projectId jako liczbę
  });

  // --- schema DSL: upsert + graf typów ---
  app.post('/v1/schemas', (req) => {
    const q = req.query as Record<string, string | undefined>;
    const projectId = Number(q['projectId']);
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) return fail(`project ${q['projectId'] ?? ''} not found`);
    const dsl = str(asRecord(req.body)['data']);
    if (dsl === '') return fail('schema data is required');

    const existing = state.schemas.find((s) => s.projectId === projectId);
    const types = parseEntityTypes(dsl, project.namespace, existing?.entityTypeDTOList ?? [], () => state.nextTypeId++);
    if (existing) {
      existing.dsl = dsl;
      existing.entityTypeDTOList = types;
    } else {
      state.schemas.push({ projectId, dsl, entityTypeDTOList: types });
    }
    persist();
    return ok(true);
  });

  app.get('/v1/schemas/graph/:projectId', (req) => {
    const projectId = Number((req.params as Record<string, string>)['projectId']);
    const schema = state.schemas.find((s) => s.projectId === projectId);
    return ok({ entityTypeDTOList: schema?.entityTypeDTOList ?? [] });
  });

  // --- rejestr modeli serwera ---
  app.get('/v1/model/list', () => ok(state.models));

  app.post('/v1/model', (req) => {
    const b = asRecord(req.body);
    const config = asRecord(b['config']);
    const instanceId = randomBytes(16).toString('hex');
    state.models.push({
      id: state.nextModelId++,
      instanceId,
      name: str(b['name']) || str(config['model']),
      provider: str(b['provider']) || 'OpenAI',
      model: str(config['model']),
      modelType: str(config['modelType']),
      // celowo BEZ api_key — sekret nie może wracać w odpowiedziach
      config: { base_url: str(config['base_url']), model: str(config['model']), modelType: str(config['modelType']) },
    });
    persist();
    return ok(instanceId);
  });

  // --- upload pliku (multipart) → pseudo-URL MinIO ---
  app.post('/public/v1/reasoner/dialog/uploadFile', (req) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const parts = parseMultipart(buf, str(req.headers['content-type']));
    const file = parts.find((p) => p.filename !== undefined) ?? parts.find((p) => p.name === 'file');
    if (!file) return fail('missing multipart field "file"');
    const fileName = file.filename ?? 'upload.bin';
    const localName = `${Date.now()}_${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    mkdirSync(uploadDir, { recursive: true });
    const path = join(uploadDir, localName);
    writeFileSync(path, file.data);
    const url = `http://release-openspg-minio:9000/builder/upload/${localName}`;
    state.uploads.push({ url, path, fileName });
    persist();
    return ok(url);
  });

  // --- builder joby ---
  app.post('/public/v1/builder/job/submit', (req) => {
    const b = asRecord(req.body);
    const extension = str(b['extension']);
    let fileName = '';
    let label = '';
    try {
      const ext = asRecord(JSON.parse(extension));
      fileName = str(asRecord(ext['dataSourceConfig'])['fileName']);
      const filter = asRecord(ext['mappingConfig'])['filter'];
      if (Array.isArray(filter)) label = str(asRecord(filter[0])['s']);
    } catch {
      // extension bywa pusty w testach ręcznych — dopuszczamy
    }
    const fileUrl = str(b['fileUrl']);
    if (fileName === '') fileName = fileUrl.split('/').pop() ?? '';
    const job: StubJob = {
      id: state.nextJobId++,
      projectId: Number(b['projectId']) || 0,
      jobName: str(b['jobName']),
      fileName,
      fileUrl,
      createUser: str(b['createUser']),
      type: str(b['type']),
      dataSourceType: str(b['dataSourceType']),
      extension,
      label,
      status: 'INIT',
      submittedAt: Date.now(),
      ingested: false,
      // umowa dev: nazwa pliku zawierająca 'fail' wymusza status ERROR
      shouldFail: fileName.includes('fail') || fileUrl.includes('fail'),
    };
    state.jobs.push(job);
    persist();
    return ok(job.id);
  });

  app.get('/public/v1/builder/job/get', (req) => {
    refreshJobs();
    const id = Number((req.query as Record<string, string | undefined>)['id']);
    const job = state.jobs.find((j) => j.id === id);
    if (!job) return fail(`job ${id} not found`);
    return ok(jobDto(job));
  });

  app.get('/public/v1/builder/job/list', (req, reply) => {
    refreshJobs();
    const q = req.query as Record<string, string | undefined>;
    const start = Number(q['start'] ?? '0');
    const limit = Number(q['limit'] ?? '10') || 10;
    if (!Number.isFinite(start) || start < 1) {
      // Emulacja buga prawdziwego serwera: start=0 → SQL z ujemnym offsetem → 500
      reply.code(500);
      return fail(
        `bad SQL grammar [... LIMIT ${(start - 1) * limit}, ${limit}]; nested exception is java.sql.SQLSyntaxErrorException`,
      );
    }
    const projectId = q['projectId'] !== undefined && q['projectId'] !== '' ? Number(q['projectId']) : undefined;
    const all = state.jobs
      .filter((j) => projectId === undefined || j.projectId === projectId)
      .sort((a, b) => b.id - a.id);
    const data = all.slice((start - 1) * limit, (start - 1) * limit + limit).map(jobDto);
    return ok({ total: all.length, data });
  });

  // --- search po "zbudowanych" chunkach ---
  app.post('/public/v1/search/text', (req) => {
    refreshJobs();
    const b = asRecord(req.body);
    const query = str(b['queryString']).toLowerCase();
    const labelsRaw = b['labelConstraints'];
    const labels = Array.isArray(labelsRaw) ? labelsRaw.filter((x): x is string => typeof x === 'string') : [];
    const size = Number(b['size']) > 0 ? Number(b['size']) : 10;
    const hits = state.chunks
      .filter((c) => labels.length === 0 || labels.includes(c.label))
      .filter(
        (c) => query !== '' && (c.content.toLowerCase().includes(query) || c.name.toLowerCase().includes(query)),
      )
      .slice(0, size)
      .map((c, i) => ({
        docId: c.id,
        score: Math.max(0.99 - i * 0.05, 0.1),
        label: c.label,
        fields: c.properties,
      }));
    return ok(hits);
  });

  app.post('/public/v1/search/vector', (req) => {
    refreshJobs();
    const b = asRecord(req.body);
    const label = str(b['label']);
    const topk = Number(b['topk']) > 0 ? Number(b['topk']) : 10;
    // deterministyczny "losowy" ranking: hash(id chunka + hash wektora zapytania)
    const vecHash = createHash('sha256').update(JSON.stringify(b['queryVector'] ?? [])).digest('hex');
    const hits = state.chunks
      .filter((c) => label === '' || c.label === label)
      .map((c) => {
        const h = createHash('sha256').update(`${c.id}|${vecHash}`).digest();
        return {
          docId: c.id,
          score: h.readUIntBE(0, 6) / 2 ** 48, // [0,1)
          label: c.label,
          fields: c.properties,
        };
      })
      .sort((a, b2) => b2.score - a.score)
      .slice(0, topk);
    return ok(hits);
  });

  return app;
}

// uruchomienie bezpośrednie: node dist/server.js
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = buildServer({ logger: true });
  const port = Number(process.env['PORT'] ?? '') || 8887;
  app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
}
