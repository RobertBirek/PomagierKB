import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startAction as repoStartAction,
  cancelAction as repoCancelAction,
  failAction,
  getAction,
  getActionOrThrow,
  setActionPid,
  readLogTail,
  nowIso,
  type ActionRow,
  type Db,
} from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';

/**
 * RUNNER AKCJI — warstwa nad repo actions z shared:
 * - startAction: wiersz w DB (guard ux_actions_running → 409 action_already_running
 *   obsługuje repo), log w DATA_DIR/actions/<yyyy>/<mm>/<id>.log, spawn detached
 *   dispatchera jobs/run-job.js ze stdout/err wprost do pliku logu, zapis pid;
 * - finalize w handlerze 'close': korekta awaryjna gdy dziecko padło bez zapisu
 *   statusu (running → error z exit code procesu);
 * - cancel: SIGTERM do CAŁEJ grupy procesów (-pid), po killTimeoutMs SIGKILL,
 *   status=cancelled zapisuje rodzic (dziecko ginie od sygnału bez zapisu);
 * - orphan recovery robi server.ts przy starcie (shared orphanSweep).
 */

export interface RunnerDeps {
  db: Db;
  /** Katalog danych (logi w <dataDir>/actions/...; dziecko dostaje DATA_DIR w env). */
  dataDir: string;
  /** Entrypoint dziecka — domyślnie ../jobs/run-job.js obok tego modułu (dist). */
  jobEntry?: string;
  /** Czas na łagodne zejście po SIGTERM przed SIGKILL (domyślnie 10 s). */
  killTimeoutMs?: number;
  /** Opcjonalny logger ostrzeżeń runnera (np. req.log.warn). */
  warn?: (msg: string) => void;
}

export interface StartActionInput {
  type: string;
  /** Zasób blokowany guardem idempotencji, np. 'kb:LightingDocs'. */
  resource: string;
  params?: Record<string, unknown>;
  /** users.id operatora (null = system). */
  startedBy?: string | null;
}

/** Katalog logu wg konwencji /data/actions/<yyyy>/<mm>/ (UTC). */
function logDirFor(dataDir: string, when = new Date()): string {
  const yyyy = String(when.getUTCFullYear());
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  return join(dataDir, 'actions', yyyy, mm);
}

/** Domyślna ścieżka entrypointu dziecka (w dist: services/ → ../jobs/run-job.js). */
function defaultJobEntry(): string {
  return fileURLToPath(new URL('../jobs/run-job.js', import.meta.url));
}

/** Bezpieczny dopisek do logu akcji (log nie może wywrócić ścieżki żądania). */
function appendLog(logPath: string, line: string, warn?: (msg: string) => void): void {
  try {
    appendFileSync(logPath, `[runner] ${nowIso()} ${line}\n`);
  } catch (err) {
    warn?.(`nie udało się dopisać do logu ${logPath}: ${(err as Error).message}`);
  }
}

/**
 * Korekta awaryjna po zakończeniu procesu potomnego: jeżeli dziecko nie zdążyło
 * zapisać statusu (crash/SIGKILL), akcja wisząca w 'running' → 'error'.
 */
function finalizeIfStillRunning(
  db: Db,
  actionId: string,
  logPath: string,
  exitCode: number | null,
  warn?: (msg: string) => void,
): void {
  try {
    const row = getAction(db, actionId);
    if (row === null || row.status !== 'running') return;
    appendLog(logPath, `proces potomny zakończył się (exit=${exitCode ?? 'brak'}) bez zapisu statusu — korekta na error`, warn);
    failAction(db, actionId, exitCode ?? 1);
  } catch (err) {
    warn?.(`korekta statusu akcji ${actionId} nie powiodła się: ${(err as Error).message}`);
  }
}

/**
 * Startuje akcję: wiersz actions (409 action_already_running z repo przy duplikacie
 * running na (type,resource)) + plik logu + spawn detached dziecka + zapis pid.
 * Zwraca świeży wiersz akcji (id, log_path, pid).
 */
export function startAction(deps: RunnerDeps, input: StartActionInput): ActionRow {
  const dir = logDirFor(deps.dataDir);
  mkdirSync(dir, { recursive: true });

  // Nazwa pliku logu zawiera id akcji, a id nadaje repo przy INSERT — wstawiamy
  // z placeholderem i od razu (przed spawnem) korygujemy log_path na docelowy.
  const inserted = repoStartAction(
    deps.db,
    input.type,
    input.resource,
    input.params ?? {},
    input.startedBy ?? null,
    join(dir, 'pending.log'),
  );
  const logPath = join(dir, `${inserted.id}.log`);
  deps.db.prepare('UPDATE actions SET log_path = ? WHERE id = ?').run(logPath, inserted.id);

  const jobEntry = deps.jobEntry ?? defaultJobEntry();
  let fd: number | null = null;
  try {
    fd = openSync(logPath, 'a');
    writeSync(fd, `[runner] ${nowIso()} start akcji ${inserted.id}: type=${input.type} resource=${input.resource}\n`);

    const child = spawn(process.execPath, [jobEntry, '--type', input.type, '--action', inserted.id], {
      detached: true, // własna grupa procesów → cancel może zabić całą grupę (-pid)
      stdio: ['ignore', fd, fd], // log pisany wprost przez deskryptor, bez pamięci rodzica
      env: { ...process.env, ACTION_ID: inserted.id, DATA_DIR: deps.dataDir },
    });

    child.once('error', (err) => {
      appendLog(logPath, `spawn/proces potomny zgłosił błąd: ${err.message}`, deps.warn);
      finalizeIfStillRunning(deps.db, inserted.id, logPath, 127, deps.warn);
    });
    child.once('close', (code) => {
      finalizeIfStillRunning(deps.db, inserted.id, logPath, code, deps.warn);
    });
    child.unref();

    if (child.pid !== undefined) setActionPid(deps.db, inserted.id, child.pid);
  } catch (err) {
    appendLog(logPath, `nie udało się wystartować procesu potomnego: ${(err as Error).message}`, deps.warn);
    try {
      failAction(deps.db, inserted.id, 127);
    } catch {
      /* akcja mogła już zostać zamknięta */
    }
    throw new AppError('internal', `nie udało się uruchomić akcji ${input.type}`, { actionId: inserted.id });
  } finally {
    if (fd !== null) closeSync(fd); // dziecko trzyma własną kopię deskryptora
  }

  return getActionOrThrow(deps.db, inserted.id);
}

/**
 * Anuluje akcję running: SIGTERM do grupy procesów (-pid), po killTimeoutMs
 * SIGKILL (timer unref — nie trzyma procesu), status=cancelled w DB.
 * Akcja nie-running → 409 conflict. Wyścig z naturalnym końcem dziecka:
 * zwracamy stan faktyczny z DB.
 */
export function cancelRunningAction(deps: Pick<RunnerDeps, 'db' | 'killTimeoutMs' | 'warn'>, actionId: string): ActionRow {
  const row = getActionOrThrow(deps.db, actionId);
  if (row.status !== 'running') {
    throw new AppError('conflict', `akcji nie można anulować — nie jest w trakcie (status: ${row.status})`, {
      status: row.status,
    });
  }

  const pid = row.pid;
  if (pid !== null && pid > 0) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* grupa mogła już nie istnieć */
    }
    const killTimer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* już nie żyje — OK */
      }
    }, deps.killTimeoutMs ?? 10_000);
    killTimer.unref();
  }

  try {
    const cancelled = repoCancelAction(deps.db, actionId);
    appendLog(row.log_path, `akcja anulowana przez operatora (SIGTERM do grupy ${pid ?? 'brak pid'})`, deps.warn);
    return cancelled;
  } catch (err) {
    // Dziecko domknęło status między naszym odczytem a cancel — oddaj stan faktyczny.
    if (err instanceof AppError && err.code === 'conflict') return getActionOrThrow(deps.db, actionId);
    throw err;
  }
}

/** Ostatnie maxLines linii logu akcji (dla logTail w GET /actions/:id). */
export function logTailLines(logPath: string, maxLines = 200): string[] {
  const text = readLogTail(logPath, 64 * 1024);
  if (text === null) return [];
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-maxLines);
}
