import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, runMigrations, getAction, orphanSweep, type Db } from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import { startAction, cancelRunningAction, logTailLines } from '../src/services/actions-runner.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';

/**
 * Testy E2E runnera akcji na jobie noop: prawdziwy spawn procesu potomnego
 * (node dist/jobs/run-job.js), wspólny plik SQLite w katalogu tymczasowym.
 * Dist jobów kompilowany w beforeAll bezpośrednio z src/jobs (tsc --noCheck,
 * niezależnie od stanu reszty workspace'u).
 */

const panelApiDir = fileURLToPath(new URL('..', import.meta.url));
const jobEntry = join(panelApiDir, 'dist', 'jobs', 'run-job.js');

let dataDir: string;
let db: Db;

/** Czeka aż warunek będzie prawdziwy (polling co 25 ms). */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout oczekiwania: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function deps(): { db: Db; dataDir: string; jobEntry: string; killTimeoutMs: number } {
  return { db, dataDir, jobEntry, killTimeoutMs: 500 };
}

/** Czy proces o danym pid żyje (sygnał 0). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  // Kompilacja WYŁĄCZNIE poddrzewa jobs do dist/jobs (układ produkcyjny).
  execSync(
    'npx tsc src/jobs/job-types.ts src/jobs/noop.ts src/jobs/run-job.ts ' +
      '--outDir dist/jobs --module nodenext --moduleResolution nodenext ' +
      '--target es2023 --skipLibCheck --noCheck',
    { cwd: panelApiDir, stdio: 'pipe' },
  );
  expect(existsSync(jobEntry)).toBe(true);

  dataDir = mkdtempSync(join(tmpdir(), 'pomagierkb-runner-'));
  db = openDb(join(dataDir, 'db', 'kag.db'));
  runMigrations(db, sharedMigrationsDir());
}, 120_000);

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('actions runner + job noop (E2E)', () => {
  it('pełny cykl: start → progress w db → success + log z @@progress', async () => {
    const row = startAction(deps(), {
      type: 'noop',
      resource: 'test:full-cycle',
      params: { sleepMs: 30 },
      startedBy: null,
    });
    expect(row.status).toBe('running');
    expect(row.pid).toBeGreaterThan(0);
    expect(row.log_path).toMatch(/actions\/\d{4}\/\d{2}\/act_\d{8}_[0-9a-f]{8}\.log$/);
    expect(row.log_path).toContain(row.id);

    await waitFor(() => getAction(db, row.id)?.status === 'success', 'status success');

    const done = getAction(db, row.id)!;
    expect(done.exit_code).toBe(0);
    expect(done.finished_at).not.toBeNull();
    // Progress zapisany do DB przez DZIECKO (ostatni krok 3/3).
    const progress = JSON.parse(done.progress_json!) as { current: number; total: number; phase: string };
    expect(progress.total).toBe(3);
    expect(progress.current).toBe(3);
    // Log zawiera linie @@progress i wpisy startowe runnera/joba.
    const log = readFileSync(done.log_path, 'utf8');
    expect(log).toContain('[runner]');
    expect(log).toContain("start joba 'noop'");
    expect(log.match(/@@progress /g)?.length).toBe(3);
    // logTail zwraca ostatnie linie.
    const tail = logTailLines(done.log_path, 200);
    expect(tail.length).toBeGreaterThan(3);
    expect(tail.some((l) => l.startsWith('@@progress'))).toBe(true);
  });

  it('duplikat (type,resource) w stanie running → 409 action_already_running', async () => {
    const first = startAction(deps(), {
      type: 'noop',
      resource: 'test:dup',
      params: { sleepMs: 3_000 },
    });
    try {
      expect(() =>
        startAction(deps(), { type: 'noop', resource: 'test:dup', params: {} }),
      ).toThrowError(
        expect.objectContaining({ code: 'action_already_running', details: { actionId: first.id } }),
      );
    } finally {
      cancelRunningAction(deps(), first.id);
    }
    await waitFor(() => !pidAlive(first.pid!), 'zejście procesu po cancel');
  });

  it('cancel przerywa akcję: SIGTERM do grupy, status=cancelled i tak zostaje', async () => {
    const row = startAction(deps(), {
      type: 'noop',
      resource: 'test:cancel',
      params: { sleepMs: 10_000 },
    });
    await waitFor(() => getAction(db, row.id)?.pid !== null, 'zapis pid');

    const cancelled = cancelRunningAction(deps(), row.id);
    expect(cancelled.status).toBe('cancelled');

    await waitFor(() => !pidAlive(row.pid!), 'zejście procesu potomnego');
    // Handler close NIE nadpisuje cancelled na error (korekta tylko dla running).
    await new Promise((r) => setTimeout(r, 300));
    expect(getAction(db, row.id)!.status).toBe('cancelled');
    // Ponowny cancel → 409 conflict.
    expect(() => cancelRunningAction(deps(), row.id)).toThrowError(AppError);
    expect(() => cancelRunningAction(deps(), row.id)).toThrowError(
      expect.objectContaining({ code: 'conflict' }),
    );
  });

  it('job z exitCode≠0 → status=error z zapisanym exit_code', async () => {
    const row = startAction(deps(), {
      type: 'noop',
      resource: 'test:exit-code',
      params: { sleepMs: 5, exitCode: 3 },
    });
    await waitFor(() => getAction(db, row.id)?.status === 'error', 'status error');
    expect(getAction(db, row.id)!.exit_code).toBe(3);
  });

  it('nieznany typ akcji → dziecko pisze error do logu i status=error (exit 2)', async () => {
    const row = startAction(deps(), { type: 'nie_ma_takiego', resource: 'test:unknown' });
    await waitFor(() => getAction(db, row.id)?.status === 'error', 'status error');
    const done = getAction(db, row.id)!;
    expect(done.exit_code).toBe(2);
    expect(readFileSync(done.log_path, 'utf8')).toContain('nieznany typ akcji');
  });

  it('dziecko ubite bez zapisu statusu → korekta close-handlera na error', async () => {
    const row = startAction(deps(), {
      type: 'noop',
      resource: 'test:sigkill',
      params: { sleepMs: 10_000 },
    });
    await waitFor(() => getAction(db, row.id)?.pid !== null, 'zapis pid');
    process.kill(-row.pid!, 'SIGKILL'); // dziecko ginie natychmiast, bez zapisu do DB
    await waitFor(() => getAction(db, row.id)?.status === 'error', 'korekta na error');
    expect(readFileSync(getAction(db, row.id)!.log_path, 'utf8')).toContain('bez zapisu statusu');
  });

  it('orphan sweep: running z podmienionym martwym pid → error', async () => {
    const row = startAction(deps(), {
      type: 'noop',
      resource: 'test:orphan',
      params: { sleepMs: 10_000 },
    });
    const realPid = getAction(db, row.id)!.pid!;
    // Symulacja restartu procesu panel-api: pid w DB wskazuje martwy proces.
    db.prepare('UPDATE actions SET pid = ? WHERE id = ?').run(2_147_000_000, row.id);
    const swept = orphanSweep(db, pidAlive);
    expect(swept).toContain(row.id);
    expect(getAction(db, row.id)!.status).toBe('error');
    // Sprzątanie realnego dziecka.
    try {
      process.kill(-realPid, 'SIGKILL');
    } catch {
      /* mogło już zejść */
    }
  });
});
