import type { ActionProgress, Db } from '@pomagierkb/shared/db';
import {
  clearDirty,
  findFinishedBuildJob,
  getKbOrThrow,
  getUploadRecord,
  recordBuildJob,
  saveUploadRecord,
  updateBuildJobStatus,
} from '@pomagierkb/shared/db';
import {
  getSchemaGraph,
  isReusableActiveJob,
  listJobs,
  submitCsvUpsertJob,
  uploadFile,
  waitForJob,
  type BuilderJob,
  type OpenSpgClient,
} from '@pomagierkb/shared/openspg';
import { loadConfig, type AppConfig } from '../config.js';
import { makeOpenSpgClient } from '../services/kb.js';
import { runPreflightFor } from '../services/preflight.js';
import { humanize } from '../services/messages.js';
import { runExport, ENTITY_BY_FILE, EXPORT_FILE_ORDER, type ExportedFile } from '../pipeline/exporter.js';
import { runQualityGate, type QualityGateReport } from '../pipeline/quality-gate.js';
import { JobFailure, type JobFn } from './job-types.js';

/**
 * Akcja build_kb (Etap 8, docs/design/pipeline-frontend.md) — proces potomny
 * przez dispatcher jobs/run-job.ts (spawn w services/actions-runner.ts):
 * preflight (JEDNA kompozycja z services/preflight.ts, twardy guard embeddingu)
 * → runExport → sekwencja topic→reference_document→chunk: upload z resume po
 * sha256 (force pomija cache) → skip gdy build FINISH dla tej treści → reuse
 * aktywnego joba (≤45 min) → submit (entityTypeId z getSchemaGraph) → polling
 * z @@progress → zapis build_jobs. Po plikach: clearDirty + quality gate.
 * Rdzeń (runBuildKb) jest wstrzykiwalny — testy podają mock klienta OpenSPG.
 */

export interface BuildKbDeps {
  db: Db;
  config: AppConfig;
  client: OpenSpgClient;
  namespace: string;
  force?: boolean;
  /** Id własnej akcji (wyłączane z checku no_running_action). */
  actionId?: string;
  log(msg: string): void;
  progress(p: ActionProgress): void;
  /** Interwał pollingu jobów buildera (testy: małe wartości), domyślnie 3 s. */
  pollMs?: number;
  /** Timeout pojedynczego joba buildera, domyślnie 120 min. */
  jobTimeoutMs?: number;
}

export interface BuildKbResult {
  runId: number;
  report: QualityGateReport;
}

const TOTAL_STEPS = 6; // preflight, export, 3 pliki, quality gate

const FINISHED_STATUSES = new Set(['FINISH', 'SET_FINISH']);

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export async function runBuildKb(deps: BuildKbDeps): Promise<BuildKbResult> {
  const { db, config, client, namespace } = deps;
  const force = deps.force === true;
  const step = (n: number, phase: string, message: string): void =>
    deps.progress({ phase, current: n, total: TOTAL_STEPS, message });

  // 1) Preflight — ta sama kompozycja co POST /kbs/:ns/preflight (trasa build
  //    już go przeszła przed 202, ale stan mógł się zmienić przed spawnem).
  step(1, 'preflight', 'Kontrola wstępna builda');
  const pf = await runPreflightFor('build_kb', {
    db,
    config,
    namespace,
    openspg: client,
    ...(deps.actionId !== undefined ? { excludeActionId: deps.actionId } : {}),
  });
  for (const c of pf.checks) {
    deps.log(`preflight ${c.id}: ${c.ok ? 'OK' : c.severity.toUpperCase()} — ${c.message}`);
  }
  if (!pf.ok) {
    const reasons = pf.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => c.message);
    throw new JobFailure(`kontrola wstępna builda nie przeszła: ${reasons.join('; ')}`, 2);
  }

  // 2) Eksport CSV + mirror + manifesty.
  step(2, 'export', 'Eksport zatwierdzonych szkiców do CSV');
  const exp = runExport({ db, dataDir: config.dataDir }, namespace);
  deps.log(`eksport #${exp.runId}: dokumentów ${exp.docCount}, chunków ${exp.chunkCount} → ${exp.dir}`);

  const kb = getKbOrThrow(db, namespace);
  if (kb.project_id === null) throw new JobFailure(`baza ${namespace} nie ma projektu OpenSPG`, 2);
  const projectId = kb.project_id;
  let schemaGraph: Map<string, number> | null = null;

  // 3-5) Sekwencja plików: topic → reference_document → chunk.
  let stepNo = 2;
  for (const fileName of EXPORT_FILE_ORDER) {
    stepNo++;
    const file: ExportedFile | undefined = exp.files.find((f) => f.fileName === fileName);
    if (file === undefined) continue; // eksport zawsze pisze 3 pliki — defensywnie
    step(stepNo, 'build', `Plik ${fileName} (${file.rowCount} wierszy)`);

    if (file.rowCount === 0) {
      deps.log(`${fileName}: 0 wierszy — pomijam upload i build`);
      continue;
    }

    // Upload z resume po sha256 treści (zmiana treści = nowy sha = nowy upload;
    // force wymusza re-upload bez zmiany treści, np. po odtworzeniu grafu).
    let uploadedUrl: string;
    const cached = getUploadRecord(db, namespace, fileName, file.sha256);
    if (cached !== null && !force) {
      uploadedUrl = cached.uploaded_url;
      deps.log(`${fileName}: upload z cache (sha256 ${file.sha256.slice(0, 12)}…) → ${uploadedUrl}`);
    } else {
      uploadedUrl = await uploadFile(client, file.path);
      saveUploadRecord(db, { namespace, fileName, fileSha256: file.sha256, uploadedUrl });
      deps.log(`${fileName}: upload${force ? ' (force)' : ''} → ${uploadedUrl}`);
    }

    // Skip: ta treść (sha) już zbudowana sukcesem — bez force nic do zrobienia.
    if (!force) {
      const done = findFinishedBuildJob(db, namespace, fileName, file.sha256);
      if (done !== null) {
        deps.log(`${fileName}: już zbudowany w tej wersji (job #${done.openspg_job_id ?? '?'}, ${done.status}) — pomijam`);
        continue;
      }
    }

    const entityShort = ENTITY_BY_FILE[fileName];
    const jobName = `${kb.job_prefix} ${entityShort} CSV Import`;

    // Reuse aktywnego joba (INIT/WAITING/RUNNING, zgodne jobName+fileUrl, ≤45 min).
    const activeJobs = await listJobs(client, projectId, { start: 1, limit: 100 });
    const reusable = isReusableActiveJob(activeJobs, { jobName, fileUrl: uploadedUrl });
    let openspgJobId: number;
    let entityTypeId: number | null = null;
    if (reusable !== undefined && typeof reusable.id === 'number') {
      openspgJobId = reusable.id;
      deps.log(`${fileName}: przejmuję aktywny job #${openspgJobId} (${String(reusable.status)}) — tylko polling`);
    } else {
      if (schemaGraph === null) schemaGraph = await getSchemaGraph(client, projectId);
      const entityLong = `${namespace}.${entityShort}`;
      const sId = schemaGraph.get(entityLong) ?? schemaGraph.get(entityShort);
      if (sId === undefined) {
        throw new JobFailure(
          `w schemacie projektu #${projectId} brak typu ${entityLong} — uruchom najpierw synchronizację schematu`,
          2,
        );
      }
      entityTypeId = sId;
      openspgJobId = await submitCsvUpsertJob(client, {
        projectId,
        createUser: config.openspg.account,
        jobName,
        fileUrl: uploadedUrl,
        fileName,
        columns: file.columns,
        entityLongName: entityLong,
        entityShortName: entityShort,
        entityTypeId: sId,
      });
      deps.log(`${fileName}: submit joba buildera → #${openspgJobId}`);
    }

    const row = recordBuildJob(db, {
      namespace,
      runId: exp.runId,
      fileName,
      fileSha256: file.sha256,
      openspgJobId,
      jobName,
      entityType: entityShort,
      entityTypeId,
      rowCount: file.rowCount,
      uploadedUrl,
      status: 'INIT',
    });

    const finalJob: BuilderJob = await waitForJob(client, openspgJobId, {
      pollMs: deps.pollMs ?? 3_000,
      timeoutMs: deps.jobTimeoutMs ?? 120 * 60_000,
      onTick: (j) => {
        const st = typeof j.status === 'string' ? j.status : 'RUNNING';
        step(stepNo, 'build', `Plik ${fileName}: ${humanize(st).label}`);
      },
    });
    const status = typeof finalJob.status === 'string' ? finalJob.status : 'ERROR';
    const gmtCreate = asOptionalString(finalJob.gmtCreate);
    const gmtModified = asOptionalString(finalJob['gmtModified']);
    updateBuildJobStatus(db, row.id, status, {
      ...(gmtCreate !== undefined ? { gmtCreate } : {}),
      ...(gmtModified !== undefined ? { gmtModified } : {}),
    });

    if (!FINISHED_STATUSES.has(status)) {
      const human = humanize(status);
      throw new JobFailure(
        `${fileName}: ${human.label}${human.action !== undefined ? ` — ${human.action}` : ''} (job #${openspgJobId}, status ${status})`,
        1,
      );
    }
    deps.log(`${fileName}: ${humanize(status).label} (job #${openspgJobId})`);
  }

  // 6) Po plikach: dirty=0 → quality gate → progress final.
  clearDirty(db, namespace);
  deps.log('dirty=0 — graf zsynchronizowany ze stanem inboxu');
  step(6, 'quality', 'Kontrola jakości eksportu i grafu');
  const report = await runQualityGate({ db, namespace, client, log: deps.log });
  deps.log(`quality gate: ${report.verdict} (${humanize(report.verdict).label})`);
  deps.progress({
    phase: 'done',
    current: TOTAL_STEPS,
    total: TOTAL_STEPS,
    message: `Build zakończony — kontrola jakości: ${humanize(report.verdict).label}`,
  });
  return { runId: exp.runId, report };
}

// ── entrypoint dispatchera (proces potomny; env = konfiguracja panel-api) ────

const runBuildKbJob: JobFn = async (ctx) => {
  const namespace = typeof ctx.params['namespace'] === 'string' ? ctx.params['namespace'] : '';
  if (namespace === '') throw new JobFailure('akcja build_kb wymaga parametru namespace', 2);
  const force = ctx.params['force'] === true;

  let config: AppConfig;
  try {
    config = { ...loadConfig(process.env), dataDir: ctx.dataDir };
  } catch (err) {
    throw new JobFailure(
      `brak kompletnej konfiguracji środowiska dla builda: ${err instanceof Error ? err.message : String(err)}`,
      2,
    );
  }
  const client = makeOpenSpgClient(config);
  await runBuildKb({
    db: ctx.db,
    config,
    client,
    namespace,
    force,
    actionId: ctx.actionId,
    log: (msg) => ctx.log(msg),
    progress: (p) => ctx.progress(p),
  });
};

export default runBuildKbJob;
