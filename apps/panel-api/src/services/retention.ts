import { readdirSync, statSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@pomagierkb/shared/db';
import { appendAudit } from '@pomagierkb/shared/audit';
import { runDueJobs, type SchedulerDeps } from '../jobs/scheduler.js';

/**
 * RETENCJA DANYCH APLIKACJI — worker konserwacyjny panelu.
 *
 * UWAGA OPERATORA: ten worker KASUJE dane (pliki z dysku i wiersze z bazy).
 * Uruchamia się automatycznie 5 minut po starcie panelu i potem co 24 h.
 * Wszystkie okresy podawane są w DNIACH i można je nadpisać kluczem `retention`
 * w ustawieniach (Ustawienia → System). Wartość < 1 albo nieliczbowa jest
 * ignorowana (zostaje domyślna). Skrócenie okresu działa wstecz przy najbliższym
 * biegu — nie ma „kosza”, usunięcie jest nieodwracalne (poza kopią zapasową).
 *
 * CO JEST KASOWANE (domyślne okresy w RETENTION_DEFAULTS):
 *  ┌ pliki ─────────────────────────────────────────────────────────────────┐
 *  │ actionLogsDays 90            <dataDir>/actions/**  (logi akcji; wiersze │
 *  │                              actions zostają do actionRowsDays)        │
 *  │ mcpUsageDays 180             <dataDir>/mcp-usage/*.jsonl (dzienniki MCP;│
 *  │                              źródło metryk per klucz/narzędzie)        │
 *  │ exportsDays 30               <dataDir>/exports/<ns>/<runId>/ — UWAGA:   │
 *  │                              po tym czasie NIE DA SIĘ powtórzyć builda  │
 *  │                              z gotowego CSV; trzeba wyeksportować       │
 *  │                              ponownie z bazy (manifesty zostają)        │
 *  │ failedIntakesDays 30         oryginały plików nieudanych intake'ów      │
 *  │ succeededIntakeBlobsDays 30  oryginały UDANYCH intake'ów (treść żyje    │
 *  │                              dalej w draftach/eksportach; kasujemy plik │
 *  │                              źródłowy z metadanymi autora — RODO)       │
 *  ├ wiersze bazy ──────────────────────────────────────────────────────────┤
 *  │ intakeRowsDays 180           intakes w stanie terminalnym bez bloba     │
 *  │ actionRowsDays 90            actions zakończone (log już usunięty)      │
 *  │ exportRunRowsDays 30         export_runs/export_files — NIGDY najnowszy │
 *  │                              bieg danej bazy (potrzebny do quality gate)│
 *  │ buildJobRowsDays 180         build_jobs i upload_records (cache uploadu)│
 *  │ answersAnonymizeDays 180     treść pytań użytkowników → '[usunięte]',   │
 *  │                              user_id/api_key_id → NULL (metryki jakości │
 *  │                              zostają: confidence, degraded, took_ms)    │
 *  │ answersDeleteDays 365        twarde usunięcie answers + ich feedbacku   │
 *  │ gapsClosedDays 365           learning_gaps resolved/ignored (otwarte    │
 *  │                              NIGDY — to kolejka pracy)                  │
 *  │ feedbackDays 365             feedback (komentarze użytkowników)         │
 *  │ llmUsageDays 365             llm_usage (rejestr tokenów/kosztu LLM)     │
 *  └────────────────────────────────────────────────────────────────────────┘
 *
 * Każdy bieg z niezerowym efektem zapisuje wpis audytu `retention.purge`
 * z licznikami i użytą polityką (zasada: każda mutacja audytowana).
 * Czysta logika wyboru celów (selectExpired) — testowana bez dotykania dysku.
 */

export interface RetentionPolicy {
  /** Pliki logów akcji starsze niż X dni (wiersze actions zostają). */
  actionLogsDays: number;
  /** Dzienniki usage MCP starsze niż X dni. */
  mcpUsageDays: number;
  /** Katalogi eksportów CSV starsze niż X dni (manifesty w DB zostają). */
  exportsDays: number;
  /** Bloby intake'ów failed starszych niż X dni (wiersz intake zostaje z adnotacją). */
  failedIntakesDays: number;
  /** Bloby intake'ów zakończonych sukcesem (status 'drafted') starszych niż X dni. */
  succeededIntakeBlobsDays: number;
  /** Wiersze intakes w stanie terminalnym, bez bloba, starsze niż X dni. */
  intakeRowsDays: number;
  /** Wiersze actions zakończone (success/error/cancelled) starsze niż X dni. */
  actionRowsDays: number;
  /** Manifesty eksportów starsze niż X dni (poza najnowszym biegiem bazy). */
  exportRunRowsDays: number;
  /** Wiersze build_jobs (terminalne) i upload_records starsze niż X dni. */
  buildJobRowsDays: number;
  /** Anonimizacja pytań w answers starszych niż X dni (metryki zostają). */
  answersAnonymizeDays: number;
  /** Twarde usunięcie answers (wraz z feedbackiem) starszych niż X dni. */
  answersDeleteDays: number;
  /** Usunięcie zamkniętych luk (resolved/ignored) starszych niż X dni. */
  gapsClosedDays: number;
  /** Usunięcie wierszy feedback starszych niż X dni. */
  feedbackDays: number;
  /** Usunięcie wierszy rejestru zużycia LLM starszych niż X dni. */
  llmUsageDays: number;
}

export const RETENTION_DEFAULTS: RetentionPolicy = {
  actionLogsDays: 90,
  mcpUsageDays: 180,
  exportsDays: 30,
  failedIntakesDays: 30,
  succeededIntakeBlobsDays: 30,
  intakeRowsDays: 180,
  actionRowsDays: 90,
  exportRunRowsDays: 30,
  buildJobRowsDays: 180,
  answersAnonymizeDays: 180,
  answersDeleteDays: 365,
  gapsClosedDays: 365,
  feedbackDays: 365,
  llmUsageDays: 365,
};

/** Znacznik anonimizacji pytania (odróżnia wiersz przetworzony od świeżego). */
export const ANONYMIZED_QUESTION = '[usunięte]';

export function readRetentionPolicy(db: Db): RetentionPolicy {
  try {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'retention'").get() as
      | { value_json: string }
      | undefined;
    if (!row) return RETENTION_DEFAULTS;
    const o = JSON.parse(row.value_json) as Record<string, unknown>;
    const num = (v: unknown, d: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : d;
    const policy = { ...RETENTION_DEFAULTS };
    for (const key of Object.keys(RETENTION_DEFAULTS) as (keyof RetentionPolicy)[]) {
      policy[key] = num(o[key], RETENTION_DEFAULTS[key]);
    }
    return policy;
  } catch {
    return RETENTION_DEFAULTS;
  }
}

export interface FileCandidate {
  path: string;
  mtimeMs: number;
}

/** CZYSTA selekcja: pliki starsze niż cutoff (now - days). */
export function selectExpired(files: FileCandidate[], days: number, now: number): string[] {
  const cutoff = now - days * 86_400_000;
  return files.filter((f) => f.mtimeMs < cutoff).map((f) => f.path);
}

function walkFiles(dir: string, depth = 3): FileCandidate[] {
  if (!existsSync(dir)) return [];
  const out: FileCandidate[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (depth > 0) out.push(...walkFiles(p, depth - 1));
    } else {
      out.push({ path: p, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

export interface RetentionRunResult {
  actionLogs: number;
  mcpUsage: number;
  exportDirs: number;
  failedIntakeBlobs: number;
  succeededIntakeBlobs: number;
  intakeRows: number;
  actionRows: number;
  exportRunRows: number;
  exportFileRows: number;
  buildJobRows: number;
  uploadRecordRows: number;
  answersAnonymized: number;
  answersDeleted: number;
  gapRows: number;
  feedbackRows: number;
  llmUsageRows: number;
}

function emptyResult(): RetentionRunResult {
  return {
    actionLogs: 0,
    mcpUsage: 0,
    exportDirs: 0,
    failedIntakeBlobs: 0,
    succeededIntakeBlobs: 0,
    intakeRows: 0,
    actionRows: 0,
    exportRunRows: 0,
    exportFileRows: 0,
    buildJobRows: 0,
    uploadRecordRows: 0,
    answersAnonymized: 0,
    answersDeleted: 0,
    gapRows: 0,
    feedbackRows: 0,
    llmUsageRows: 0,
  };
}

/** ISO cutoff dla progu w dniach. */
function cutoffIso(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString();
}

/**
 * Kasuje oryginały intake'ów w danym statusie i zeruje blob_path. Blob bywa
 * współdzielony (dedupe po sha256 treści) — plik znika dopiero, gdy nie wskazuje
 * na niego żaden INNY intake.
 */
function purgeIntakeBlobs(db: Db, statuses: string[], cutoff: string): number {
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, blob_path FROM intakes
        WHERE status IN (${placeholders}) AND blob_path IS NOT NULL AND updated_at < ?`,
    )
    .all(...statuses, cutoff) as { id: string; blob_path: string }[];
  let removed = 0;
  for (const row of rows) {
    const shared = (
      db.prepare('SELECT COUNT(*) AS n FROM intakes WHERE blob_path = ? AND id != ?').get(row.blob_path, row.id) as {
        n: number;
      }
    ).n;
    if (shared > 0) continue;
    try {
      if (existsSync(row.blob_path)) unlinkSync(row.blob_path);
      db.prepare('UPDATE intakes SET blob_path = NULL WHERE id = ?').run(row.id);
      removed++;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

/**
 * Retencja wierszy bazy (D14-03, D14-09). Kolejność wymuszona kluczami obcymi:
 * feedback → answers, export_files → export_runs. Całość w jednej transakcji;
 * audyt dopisywany PO commicie (appendAudit otwiera własne BEGIN IMMEDIATE).
 */
function purgeRows(db: Db, policy: RetentionPolicy, now: number, result: RetentionRunResult): void {
  const tx = db.transaction(() => {
    // Pytania użytkowników: najpierw twarde usunięcie najstarszych (wraz
    // z feedbackiem, bo feedback.answer_id ma klucz obcy), potem anonimizacja.
    const deleteCut = cutoffIso(now, policy.answersDeleteDays);
    result.feedbackRows += db
      .prepare('DELETE FROM feedback WHERE answer_id IN (SELECT id FROM answers WHERE created_at < ?)')
      .run(deleteCut).changes;
    result.answersDeleted += db.prepare('DELETE FROM answers WHERE created_at < ?').run(deleteCut).changes;

    const anonCut = cutoffIso(now, policy.answersAnonymizeDays);
    result.answersAnonymized += db
      .prepare(
        `UPDATE answers SET question = ?, user_id = NULL, api_key_id = NULL
          WHERE created_at < ? AND question <> ?`,
      )
      .run(ANONYMIZED_QUESTION, anonCut, ANONYMIZED_QUESTION).changes;

    result.feedbackRows += db
      .prepare('DELETE FROM feedback WHERE created_at < ?')
      .run(cutoffIso(now, policy.feedbackDays)).changes;

    // Luki: tylko zamknięte. Otwarte to kolejka pracy — nie kasujemy ich nigdy.
    result.gapRows += db
      .prepare(
        `DELETE FROM learning_gaps
          WHERE status IN ('resolved','ignored') AND COALESCE(processed_at, created_at) < ?`,
      )
      .run(cutoffIso(now, policy.gapsClosedDays)).changes;

    // Intakes: wiersz idzie do kasacji dopiero gdy blob już zniknął (inaczej
    // zostawilibyśmy plik-sierotę bez żadnego wskaźnika).
    result.intakeRows += db
      .prepare(
        `DELETE FROM intakes
          WHERE status IN ('drafted','failed') AND blob_path IS NULL AND updated_at < ?`,
      )
      .run(cutoffIso(now, policy.intakeRowsDays)).changes;

    result.actionRows += db
      .prepare(
        `DELETE FROM actions
          WHERE status IN ('success','error','cancelled') AND finished_at IS NOT NULL AND finished_at < ?`,
      )
      .run(cutoffIso(now, policy.actionRowsDays)).changes;

    // Manifesty eksportów: NIGDY najnowszy bieg danej bazy (quality gate i resume
    // czytają ostatni eksport nawet po roku bez przebudowy).
    const exportCut = cutoffIso(now, policy.exportRunRowsDays);
    const staleRuns = `SELECT id FROM export_runs
        WHERE started_at < ? AND id NOT IN (SELECT MAX(id) FROM export_runs GROUP BY namespace)`;
    result.exportFileRows += db
      .prepare(`DELETE FROM export_files WHERE run_id IN (${staleRuns})`)
      .run(exportCut).changes;
    result.exportRunRows += db.prepare(`DELETE FROM export_runs WHERE id IN (${staleRuns})`).run(exportCut).changes;

    const buildCut = cutoffIso(now, policy.buildJobRowsDays);
    result.buildJobRows += db
      .prepare(
        `DELETE FROM build_jobs
          WHERE finished_at IS NOT NULL AND finished_at < ?
            AND status NOT IN ('INIT','WAITING','RUNNING')`,
      )
      .run(buildCut).changes;
    result.uploadRecordRows += db
      .prepare('DELETE FROM upload_records WHERE uploaded_at < ?')
      .run(buildCut).changes;

    try {
      result.llmUsageRows += db
        .prepare('DELETE FROM llm_usage WHERE at < ?')
        .run(cutoffIso(now, policy.llmUsageDays)).changes;
    } catch {
      /* starsza baza bez tabeli llm_usage */
    }
  });
  tx.immediate();
}

export function runRetention(db: Db, dataDir: string, now = Date.now()): RetentionRunResult {
  const policy = readRetentionPolicy(db);
  const result = emptyResult();

  for (const path of selectExpired(walkFiles(join(dataDir, 'actions')), policy.actionLogsDays, now)) {
    try {
      unlinkSync(path);
      result.actionLogs++;
    } catch {
      /* best-effort */
    }
  }
  for (const path of selectExpired(walkFiles(join(dataDir, 'mcp-usage'), 0), policy.mcpUsageDays, now)) {
    try {
      unlinkSync(path);
      result.mcpUsage++;
    } catch {
      /* best-effort */
    }
  }

  // Eksporty: całe katalogi <dataDir>/exports/<ns>/<runId> starsze niż polityka.
  const exportsRoot = join(dataDir, 'exports');
  if (existsSync(exportsRoot)) {
    const cutoff = now - policy.exportsDays * 86_400_000;
    for (const ns of readdirSync(exportsRoot)) {
      const nsDir = join(exportsRoot, ns);
      let entries: string[] = [];
      try {
        entries = readdirSync(nsDir);
      } catch {
        continue;
      }
      for (const runId of entries) {
        const dir = join(nsDir, runId);
        try {
          if (statSync(dir).mtimeMs < cutoff) {
            rmSync(dir, { recursive: true, force: true });
            result.exportDirs++;
          }
        } catch {
          /* best-effort */
        }
      }
    }
  }

  // Bloby intake'ów: nieudane wcześniej (diagnostyka), udane po własnym progu —
  // treść udanego intake'u żyje w szkicu/eksportach, oryginał z metadanymi
  // autora nie ma powodu leżeć na dysku bez końca (D14-09).
  result.failedIntakeBlobs = purgeIntakeBlobs(db, ['failed'], cutoffIso(now, policy.failedIntakesDays));
  result.succeededIntakeBlobs = purgeIntakeBlobs(
    db,
    ['drafted'],
    cutoffIso(now, policy.succeededIntakeBlobsDays),
  );

  purgeRows(db, policy, now, result);

  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total > 0) {
    appendAudit(db, {
      actor: 'system',
      actorType: 'system',
      action: 'retention.purge',
      resourceType: 'files',
      resourceId: 'retention',
      metadata: { ...result, policy: { ...policy } },
    });
  }
  return result;
}

/**
 * Ścieżka usunięcia danych JEDNEGO użytkownika (RODO, ustalenie D14-03):
 * kasuje jego feedback i odpowiedzi oraz odcina powiązanie luk wiedzy od pytania.
 * Zwraca liczniki i zapisuje audyt. Wywoływane przez trasę „usuń moją historię”
 * albo przez administratora dla wskazanego konta.
 */
export function purgeUserAnswers(
  db: Db,
  userId: string,
  actor: { actor: string; actorType: 'user' | 'api_key' | 'system' } = {
    actor: userId,
    actorType: 'user',
  },
): { answers: number; feedback: number } {
  const counts = db.transaction(() => {
    const feedback = db
      .prepare('DELETE FROM feedback WHERE answer_id IN (SELECT id FROM answers WHERE user_id = ?)')
      .run(userId).changes;
    const answers = db.prepare('DELETE FROM answers WHERE user_id = ?').run(userId).changes;
    return { answers, feedback };
  }).immediate();
  appendAudit(db, {
    ...actor,
    action: 'retention.purge_user',
    resourceType: 'user',
    resourceId: userId,
    metadata: counts,
  });
  return counts;
}

export interface RetentionWorkerHandle {
  stop(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Worker konserwacyjny (pierwszy bieg po 5 min od startu — nie opóźnia bootu):
 * retencja danych + harmonogram jobów cyklicznych (jobs/scheduler.ts). Oba kroki
 * są od siebie niezależne — wyjątek jednego nie blokuje drugiego.
 */
export function startRetentionWorker(opts: {
  db: Db;
  dataDir: string;
  logger?: FastifyBaseLogger;
  intervalMs?: number;
  initialDelayMs?: number;
  /** false wyłącza harmonogram jobów (testy, tryby serwisowe). */
  scheduleJobs?: boolean;
  /** Wstrzykiwany start akcji — testy sprawdzają wpięcie bez spawnu procesu. */
  startActionImpl?: SchedulerDeps['startActionImpl'];
}): RetentionWorkerHandle {
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const run = (): void => {
    try {
      const result = runRetention(opts.db, opts.dataDir);
      opts.logger?.info({ result }, 'retencja danych wykonana');
    } catch (err) {
      opts.logger?.warn({ err }, 'retencja danych nie powiodła się');
    }
    if (opts.scheduleJobs !== false) {
      try {
        const started = runDueJobs({
          db: opts.db,
          dataDir: opts.dataDir,
          ...(opts.startActionImpl !== undefined ? { startActionImpl: opts.startActionImpl } : {}),
          log: (msg) => opts.logger?.info({ msg }, 'harmonogram jobów'),
        });
        if (started.length > 0) opts.logger?.info({ started }, 'harmonogram: uruchomiono joby cykliczne');
      } catch (err) {
        opts.logger?.warn({ err }, 'harmonogram jobów nie powiódł się');
      }
    }
  };
  const first = setTimeout(run, opts.initialDelayMs ?? 5 * 60_000);
  first.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
