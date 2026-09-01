import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { AppError, UpstreamError } from '../errors.js';
import type { OpenSpgClient } from './client.js';

/** Statusy jobów buildera (SKILL.md). */
export const TERMINAL_JOB_STATUSES = new Set(['FINISH', 'ERROR', 'SKIP', 'TERMINATE', 'SET_FINISH']);
export const ACTIVE_JOB_STATUSES = new Set(['INIT', 'WAITING', 'RUNNING']);

export interface BuilderJob {
  id?: number;
  jobName?: string;
  fileUrl?: string;
  status?: string;
  gmtCreate?: string;
  [key: string]: unknown;
}

export type UploadSource = string | { name: string; content: string | Uint8Array };

/**
 * POST /public/v1/reasoner/dialog/uploadFile (multipart, pole 'file') → URL w MinIO.
 * Przyjmuje ścieżkę pliku albo {name, content}.
 */
export async function uploadFile(client: OpenSpgClient, source: UploadSource): Promise<string> {
  const name = typeof source === 'string' ? basename(source) : source.name;
  const content = typeof source === 'string' ? readFileSync(source) : source.content;
  const data = typeof content === 'string' ? content : new Uint8Array(content);
  const form = new FormData();
  form.append('file', new Blob([data]), name);
  const result = await client.requestResult('/public/v1/reasoner/dialog/uploadFile', {
    method: 'POST',
    body: form, // content-type multipart z boundary ustawia fetch
  });
  if (typeof result !== 'string' || result === '') {
    throw new UpstreamError('openspg', '/public/v1/reasoner/dialog/uploadFile', undefined,
      'upload nie zwrócił URL pliku');
  }
  return result;
}

export interface SubmitCsvUpsertJobParams {
  projectId: number;
  createUser: string;
  jobName: string;
  fileUrl: string;    // URL z uploadFile (MinIO)
  fileName: string;   // np. 'chunk.csv'
  columns: string[];  // nagłówki CSV w kolejności
  entityLongName: string;  // 'Ns.Entity'
  entityShortName: string; // 'Entity'
  entityTypeId: number;    // sId z getSchemaGraph
}

/** Buduje DOKŁADNY payload submit (extension = ZSERIALIZOWANY JSON) — eksport dla testów. */
export function buildCsvUpsertJobPayload(params: SubmitCsvUpsertJobParams): Record<string, unknown> {
  const extension = {
    dataSourceConfig: {
      columns: params.columns.map((name, index) => ({ name, index })),
      type: 'UPLOAD',
      fileName: params.fileName,
      fileUrl: params.fileUrl,
      ignoreHeader: true,
      structure: true,
    },
    mappingConfig: {
      mappingType: 'entityMapping',
      filter: [{
        s: params.entityLongName,
        sId: params.entityTypeId,
        sZhName: params.entityShortName,
        importSchemaCategory: 'ENTITY',
      }],
      // mapping: każda kolumna → [ta sama kolumna]
      config: [{
        mapping: Object.fromEntries(params.columns.map((c) => [c, [c]])),
        name: `${params.entityShortName}(${params.entityLongName})`,
        id: '1',
      }],
    },
  };
  return {
    projectId: params.projectId,
    createUser: params.createUser,
    jobName: params.jobName,
    type: 'FILE_EXTRACT',
    dataSourceType: 'CSV',
    fileUrl: params.fileUrl,
    lifeCycle: 'ONCE',
    action: 'UPSERT',
    extension: JSON.stringify(extension),
  };
}

/** POST /public/v1/builder/job/submit → jobId. */
export async function submitCsvUpsertJob(
  client: OpenSpgClient,
  params: SubmitCsvUpsertJobParams,
): Promise<number> {
  const result = await client.postJson('/public/v1/builder/job/submit', buildCsvUpsertJobPayload(params));
  const id = typeof result === 'object' && result !== null
    ? Number((result as Record<string, unknown>)['id'])
    : Number(result);
  if (!Number.isFinite(id)) {
    throw new UpstreamError('openspg', '/public/v1/builder/job/submit', undefined,
      'submit joba nie zwrócił jobId');
  }
  return id;
}

/** GET /public/v1/builder/job/get?id= */
export async function getJob(client: OpenSpgClient, id: number): Promise<BuilderJob> {
  const result = await client.requestResult(`/public/v1/builder/job/get?id=${encodeURIComponent(id)}`);
  if (!result || typeof result !== 'object') {
    throw new UpstreamError('openspg', '/public/v1/builder/job/get', undefined, `brak joba id=${id}`);
  }
  return result as BuilderJob;
}

/** GET /public/v1/builder/job/list — start NIGDY 0 (bug SQL z ujemnym offsetem). */
export async function listJobs(
  client: OpenSpgClient,
  projectId: number,
  opts: { start?: number; limit?: number } = {},
): Promise<BuilderJob[]> {
  const start = Math.max(1, opts.start ?? 1);
  const limit = opts.limit ?? 100;
  const result = await client.requestResult(
    `/public/v1/builder/job/list?projectId=${encodeURIComponent(projectId)}&start=${start}&limit=${limit}`,
  );
  const list = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as { data?: unknown }).data)
      ? ((result as { data: unknown[] }).data)
      : [];
  return list.filter((j): j is BuilderJob => !!j && typeof j === 'object');
}

export interface WaitForJobOptions {
  pollMs?: number;
  timeoutMs?: number;
  onTick?: (job: BuilderJob) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polling joba co pollMs (domyślnie 3 s) aż do statusu terminalnego
 * (FINISH|ERROR|SKIP|TERMINATE|SET_FINISH); po timeoutMs (domyślnie 120 min)
 * rzuca AppError('upstream_timeout').
 */
export async function waitForJob(
  client: OpenSpgClient,
  id: number,
  opts: WaitForJobOptions = {},
): Promise<BuilderJob> {
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 120 * 60_000;
  const startedAt = Date.now();
  for (;;) {
    const job = await getJob(client, id);
    const status = typeof job.status === 'string' ? job.status : '';
    if (TERMINAL_JOB_STATUSES.has(status)) return job;
    opts.onTick?.(job);
    if (Date.now() - startedAt >= timeoutMs) {
      throw new AppError('upstream_timeout',
        `builder job ${id} nie zakończył się w ${Math.round(timeoutMs / 60_000)} min (ostatni status: ${status || 'brak'})`);
    }
    await delay(pollMs);
  }
}

function jobCreatedAtMs(job: BuilderJob): number | null {
  const raw = job['gmtCreate'] ?? job['createTime'] ?? job['createdAt'];
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Job wiszący w INIT/WAITING/RUNNING można przejąć (polling zamiast duplikatu submit)
 * tylko gdy zgadza się (jobName, fileUrl) i wiek ≤ maxAgeMs (domyślnie 45 min).
 */
export function isReusableActiveJob(
  jobs: BuilderJob[],
  opts: { jobName: string; fileUrl: string; maxAgeMs?: number },
): BuilderJob | undefined {
  const maxAgeMs = opts.maxAgeMs ?? 45 * 60_000;
  return jobs.find((job) => {
    if (!ACTIVE_JOB_STATUSES.has(typeof job.status === 'string' ? job.status : '')) return false;
    if (job.jobName !== opts.jobName || job.fileUrl !== opts.fileUrl) return false;
    const created = jobCreatedAtMs(job);
    return created !== null && Date.now() - created <= maxAgeMs;
  });
}
