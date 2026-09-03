import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  openDb,
  nowIso,
  getAction,
  updateActionProgress,
  finishAction,
  failAction,
  type ActionProgress,
} from '@pomagierkb/shared/db';
import { JobFailure, type JobContext, type JobFn } from './job-types.js';

/**
 * DISPATCHER PROCESÓW POTOMNYCH AKCJI (entrypoint: node dist/jobs/run-job.js
 * --type <typ> --action <actionId>; DATA_DIR z env). Uruchamiany przez
 * services/actions-runner.ts ze stdout/stderr przekierowanym do pliku logu
 * akcji — wszystko co piszemy na stdout ląduje w DATA_DIR/actions/.../<id>.log.
 *
 * Odpowiedzialności DZIECKA (rodzic nic nie parsuje):
 * - własne połączenie SQLite (WAL + busy_timeout współdzieli plik z panel-api);
 * - progress: linia '@@progress {phase,current,total,message}' w logu ORAZ
 *   update actions.progress_json;
 * - na końcu status/exit_code/finished_at (finishAction/failAction);
 * - nieznany typ akcji → wpis w logu, status=error, exit 2.
 */

/** Rejestr typów jobów → dynamiczny import implementacji (jobs/<type>.ts). */
const JOB_MODULES: Record<string, () => Promise<{ default: JobFn }>> = {
  noop: () => import('./noop.js'),
  build_kb: () => import('./build-kb.js'),
  quality_gate: () => import('./quality-gate.js'),
  quality_answers: () => import('./quality-answers.js'),
  // gap_research: auto-research luk z sieci — ŚWIADOMIE niezaimplementowane
  // (decyzja v1: bez auto-draftów; setting 'learning.autoDraft' zarezerwowany,
  // fast-follow po sprawdzeniu ingestu URL — plan rozbudowy F8.4).
};

/** Linia logu z timestampem — stdout jest podpięty do pliku logu akcji. */
function out(msg: string): void {
  process.stdout.write(`[job] ${nowIso()} ${msg}\n`);
}

interface ParsedArgs {
  type: string | null;
  actionId: string | null;
}

/** Parsuje --type/--action z argv (bez zależności; brak wartości → null). */
export function parseJobArgs(argv: string[]): ParsedArgs {
  let type: string | null = null;
  let actionId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--type') type = argv[i + 1] ?? null;
    else if (argv[i] === '--action') actionId = argv[i + 1] ?? null;
  }
  return { type, actionId };
}

/**
 * Wykonuje joba i domyka status akcji w DB. Zwraca exit code procesu.
 * Zapisy statusu owinięte w try/catch — akcja mogła zostać w międzyczasie
 * anulowana przez rodzica (terminate rzuca conflict; log wystarczy).
 */
export async function runJob(type: string, actionId: string, dataDir: string): Promise<number> {
  const db = openDb(join(dataDir, 'db', 'kag.db'));
  try {
    const row = getAction(db, actionId);
    if (row === null) {
      out(`akcja nie istnieje w DB: ${actionId}`);
      return 2;
    }

    const loader = JOB_MODULES[type];
    if (loader === undefined) {
      out(`nieznany typ akcji: ${type} (znane: ${Object.keys(JOB_MODULES).join(', ')})`);
      try {
        failAction(db, actionId, 2);
      } catch {
        /* akcja mogła już być zamknięta */
      }
      return 2;
    }

    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.params_json) as Record<string, unknown>;
    } catch {
      out('params_json nieparsowalny — jadę z pustymi parametrami');
    }

    const ctx: JobContext = {
      db,
      actionId,
      dataDir,
      params,
      progress(p: ActionProgress): void {
        process.stdout.write(`@@progress ${JSON.stringify(p)}\n`);
        try {
          updateActionProgress(db, actionId, p);
        } catch {
          /* akcja zakończona/anulowana — spóźniony progress ignorujemy */
        }
      },
      log(msg: string): void {
        out(msg);
      },
    };

    out(`start joba '${type}' dla akcji ${actionId}`);
    try {
      const job = (await loader()).default;
      await job(ctx);
      try {
        finishAction(db, actionId, 0);
      } catch {
        out('nie udało się zapisać statusu success (akcja już zamknięta?)');
      }
      out('job zakończony sukcesem');
      return 0;
    } catch (err) {
      const exitCode = err instanceof JobFailure ? err.exitCode : 1;
      out(`job nie powiódł się: ${err instanceof Error ? err.message : String(err)}`);
      try {
        failAction(db, actionId, exitCode);
      } catch {
        out('nie udało się zapisać statusu error (akcja już zamknięta?)');
      }
      return exitCode;
    }
  } finally {
    db.close();
  }
}

// ── entrypoint (tylko gdy plik uruchomiony bezpośrednio, nie przy imporcie) ──
const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) {
  const { type, actionId } = parseJobArgs(process.argv.slice(2));
  const resolvedAction = actionId ?? process.env['ACTION_ID'] ?? null;
  const dataDir = process.env['DATA_DIR'] ?? null;
  if (type === null || resolvedAction === null || dataDir === null) {
    out(`brak wymaganych argumentów: --type=${type ?? '?'} --action=${resolvedAction ?? '?'} DATA_DIR=${dataDir ?? '?'}`);
    process.exit(2);
  }
  runJob(type, resolvedAction, dataDir)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      out(`nieobsłużony błąd dispatchera: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      process.exit(1);
    });
}
