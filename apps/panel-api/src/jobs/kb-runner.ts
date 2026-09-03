import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '@pomagierkb/shared/db';
import {
  failAction,
  finishAction,
  startAction,
  updateActionProgress,
} from '@pomagierkb/shared/db';
import type { OpenSpgClient } from '@pomagierkb/shared/openspg';
import type { AppConfig } from '../config.js';

/**
 * Lekki runner akcji KB (create_kb, schema_sync) — IN-PROCESS.
 *
 * Wzorzec 202+actionId: wiersz w `actions` (guard ux_actions_running → 409),
 * log w /data/actions/<yyyy>/<mm>/<actionId>.log, progres jako linie
 * `@@progress {json}` + actions.progress_json. Provisioning to kilka krótkich
 * wywołań HTTP, więc bieg w tym samym procesie jest bezpieczny.
 *
 * Długobieżny build_kb idzie przez services/actions-runner.ts (spawn detached
 * dist/jobs/run-job.js — patrz POST /kbs/:ns/build); ten runner obsługuje
 * krótkie akcje provisioningu. Kontrakt (wiersz actions + format logu +
 * @@progress) jest w obu ścieżkach identyczny.
 */

export interface KbJobContext {
  db: Db;
  config: AppConfig;
  client: OpenSpgClient;
  actionId: string;
  namespace: string;
  startedBy: string | null;
  /** Dopisuje linię do logu akcji (z timestampem ISO). */
  log(line: string): void;
  /** Linia @@progress w logu + aktualizacja actions.progress_json. */
  progress(p: { phase: string; current: number; total: number; message: string }): void;
}

export interface LaunchedKbAction {
  actionId: string;
  type: string;
  resource: string;
  logPath: string;
  /**
   * Promise biegu joba — NIGDY nie odrzuca (runner łapie wszystko i ustawia
   * status akcji). Trasa go ignoruje (202); testy mogą await-ować determinizm.
   */
  done: Promise<void>;
}

export interface LaunchKbActionDeps {
  db: Db;
  config: AppConfig;
  client: OpenSpgClient;
  startedBy: string | null;
}

export interface LaunchKbActionOpts {
  type: string;
  namespace: string;
  params: Record<string, unknown>;
  run: (ctx: KbJobContext) => Promise<void>;
}

/**
 * Startuje akcję (INSERT z guardem idempotencji — 409 action_already_running
 * gdy trwa) i uruchamia joba w tle. Zwraca natychmiast dane do odpowiedzi 202.
 */
export function launchKbAction(deps: LaunchKbActionDeps, opts: LaunchKbActionOpts): LaunchedKbAction {
  const { db, config } = deps;
  const resource = `kb:${opts.namespace}`;

  // Ścieżka logu zawiera actionId (generowany w startAction) — najpierw INSERT
  // z pustym log_path, potem uzupełnienie w tej samej sekundzie.
  const action = startAction(db, opts.type, resource, opts.params, deps.startedBy, '');
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const logPath = join(config.dataDir, 'actions', yyyy, mm, `${action.id}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  db.prepare('UPDATE actions SET log_path = ? WHERE id = ?').run(logPath, action.id);

  const log = (line: string): void => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch {
      // Log na dysku jest best-effort — stan akcji i tak żyje w DB.
    }
  };

  const ctx: KbJobContext = {
    db,
    config,
    client: deps.client,
    actionId: action.id,
    namespace: opts.namespace,
    startedBy: deps.startedBy,
    log,
    progress(p): void {
      log(`@@progress ${JSON.stringify(p)}`);
      try {
        updateActionProgress(db, action.id, p);
      } catch {
        // Spóźniony progres po zakończeniu akcji — ignorowany.
      }
    },
  };

  const done = (async (): Promise<void> => {
    log(`start akcji ${opts.type} (${resource})`);
    try {
      await opts.run(ctx);
      try {
        finishAction(db, action.id, 0);
      } catch {
        // Akcja mogła zostać anulowana w międzyczasie — nie nadpisujemy statusu.
      }
      log('akcja zakończona sukcesem');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`BŁĄD: ${message}`);
      try {
        failAction(db, action.id, 1);
      } catch {
        // j.w. — status terminalny już ustawiony.
      }
    }
  })();

  return { actionId: action.id, type: opts.type, resource, logPath, done };
}
