import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, runMigrations, createKb, startAction as repoStartAction, setSetting, type Db } from '@pomagierkb/shared/db';
import { OpenSpgClient } from '@pomagierkb/shared/openspg';
import { AppError } from '@pomagierkb/shared/errors';
import { makeTestConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import {
  runPreflight,
  runPreflightFor,
  assertPreflight,
  diskSpaceCheck,
  dirWritableCheck,
  openspgAliveCheck,
  kbActiveCheck,
  embeddingMatchesCheck,
  noRunningActionCheck,
  configuredEmbeddingModel,
  PREFLIGHT_CHECK_IDS,
  PREFLIGHTS,
  type Check,
} from '../src/services/preflight.js';

/** Fałszywy fetch OpenSPG: login z Set-Cookie + odpowiedzi wg handlera. */
function fakeOpenspgClient(handler: (path: string) => unknown): OpenSpgClient {
  const impl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search;
    if (path.startsWith('/v1/accounts/login')) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'set-cookie': 'SESSION=test; Path=/' },
      });
    }
    const body = handler(path);
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return new OpenSpgClient({
    baseUrl: 'http://openspg.test:8887',
    account: 'a',
    password: 'p',
    fetchImpl: impl,
    timeoutMs: 1_000,
  });
}

let dataDir: string;
let db: Db;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'pomagierkb-preflight-'));
  db = openDb(':memory:');
  runMigrations(db, sharedMigrationsDir());
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('runPreflight — silnik', () => {
  it('warn nie blokuje (ok=true), error blokuje (ok=false); wyjątek = ok:false', async () => {
    const checks: Check[] = [
      { id: 'a', severity: 'error', run: () => ({ ok: true, message: 'ok' }) },
      { id: 'b', severity: 'warn', run: () => ({ ok: false, message: 'ostrzeżenie' }) },
      { id: 'c', severity: 'error', run: () => Promise.reject(new Error('wybuch')) },
    ];
    const result = await runPreflight(checks);
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(3);
    expect(result.checks[1]).toMatchObject({ id: 'b', ok: false, severity: 'warn' });
    expect(result.checks[2]!.message).toContain('wybuch');

    const softOnly = await runPreflight(checks.slice(0, 2));
    expect(softOnly.ok).toBe(true); // sam warn nie blokuje
  });

  it('assertPreflight → AppError preflight_failed (422) z details.checks', async () => {
    const result = await runPreflight([
      { id: 'x', severity: 'error', run: () => ({ ok: false, message: 'źle' }) },
    ]);
    try {
      assertPreflight(result);
      expect.unreachable('assertPreflight powinno rzucić');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('preflight_failed');
      expect(appErr.statusCode).toBe(422);
      expect(appErr.details).toEqual({
        checks: [{ id: 'x', ok: false, severity: 'error', message: 'źle' }],
      });
    }
  });
});

describe('checki wbudowane', () => {
  it('disk_space: przechodzi przy minimalnym progu, blokuje przy absurdalnym', async () => {
    const ok = await runPreflight([diskSpaceCheck(dataDir, 1)]);
    expect(ok.checks[0]).toMatchObject({ id: 'disk_space', ok: true });
    const tooMuch = await runPreflight([diskSpaceCheck(dataDir, Number.MAX_SAFE_INTEGER)]);
    expect(tooMuch.checks[0]!.ok).toBe(false);
    expect(tooMuch.ok).toBe(false);
  });

  it('dir_writable: zapisywalny ok, niezapisywalny błąd', async () => {
    const writable = await runPreflight([dirWritableCheck(join(dataDir, 'nowy', 'katalog'))]);
    expect(writable.checks[0]).toMatchObject({ id: 'dir_writable', ok: true });

    const lockedDir = join(dataDir, 'zablokowany');
    mkdirSync(lockedDir);
    chmodSync(lockedDir, 0o500); // bez prawa zapisu
    try {
      const denied = await runPreflight([dirWritableCheck(join(lockedDir, 'w-srodku'))]);
      // Uwaga: pod rootem chmod nie blokuje zapisu — wtedy check przejdzie.
      if (process.getuid?.() !== 0) {
        expect(denied.checks[0]!.ok).toBe(false);
        expect(denied.checks[0]!.message).toContain('niezapisywalny');
      }
    } finally {
      chmodSync(lockedDir, 0o700);
    }
  });

  it('openspg_alive: działający upstream ok, padnięty → ok:false z komunikatem', async () => {
    const alive = await runPreflight([
      openspgAliveCheck(fakeOpenspgClient(() => ({ success: true, result: [{ id: 1, name: 'X', namespace: 'X' }] }))),
    ]);
    expect(alive.checks[0]).toMatchObject({ id: 'openspg_alive', ok: true });
    expect(alive.checks[0]!.message).toContain('projekty: 1');

    const dead = await runPreflight([
      openspgAliveCheck(fakeOpenspgClient(() => new TypeError('fetch failed'))),
    ]);
    expect(dead.checks[0]!.ok).toBe(false);
    expect(dead.ok).toBe(false);
  });

  it('kb_active + embedding_matches + no_running_action na rejestrze', async () => {
    createKb(db, { namespace: 'PreflightKb', name: 'Test', embeddingModel: 'bge-m3' });

    // KB w stanie draft → kb_active blokuje.
    const draft = await runPreflight([kbActiveCheck(db, 'PreflightKb')]);
    expect(draft.checks[0]).toMatchObject({ id: 'kb_active', ok: false, severity: 'error' });

    db.prepare("UPDATE kb_registry SET status = 'active' WHERE namespace = 'PreflightKb'").run();
    const active = await runPreflight([kbActiveCheck(db, 'PreflightKb')]);
    expect(active.checks[0]!.ok).toBe(true);

    // Brak konfiguracji embeddings → warn (nie blokuje).
    expect(configuredEmbeddingModel(db)).toBeNull();
    const noConfig = await runPreflight([embeddingMatchesCheck(db, 'PreflightKb', configuredEmbeddingModel(db))]);
    expect(noConfig.checks[0]).toMatchObject({ id: 'embedding_matches', ok: false, severity: 'warn' });
    expect(noConfig.ok).toBe(true);

    // Zgodny model → ok; niezgodny → error (model projektu niezmienialny).
    setSetting(db, 'llm.embeddings', { model: 'bge-m3', baseUrl: 'http://llm.test' });
    expect(configuredEmbeddingModel(db)).toBe('bge-m3');
    const match = await runPreflight([embeddingMatchesCheck(db, 'PreflightKb', configuredEmbeddingModel(db))]);
    expect(match.checks[0]!.ok).toBe(true);
    const mismatch = await runPreflight([embeddingMatchesCheck(db, 'PreflightKb', 'inny-model')]);
    expect(mismatch.checks[0]).toMatchObject({ ok: false, severity: 'error' });
    expect(mismatch.checks[0]!.message).toContain('NIEZGODNY');

    // no_running_action: wolny zasób ok; running blokuje z id akcji.
    const free = await runPreflight([noRunningActionCheck(db, 'build_kb', 'kb:PreflightKb')]);
    expect(free.checks[0]!.ok).toBe(true);
    const running = repoStartAction(db, 'build_kb', 'kb:PreflightKb', {}, null, join(dataDir, 'x.log'));
    const busy = await runPreflight([noRunningActionCheck(db, 'build_kb', 'kb:PreflightKb')]);
    expect(busy.checks[0]!.ok).toBe(false);
    expect(busy.checks[0]!.message).toContain(running.id);
  });
});

describe('rejestr PREFLIGHTS', () => {
  it('build_kb komponuje pełny zestaw checków; brak namespace → validation_error', async () => {
    const config = makeTestConfig({ dataDir });
    const ctx = {
      db,
      config,
      namespace: 'PreflightKb',
      openspg: fakeOpenspgClient(() => ({ success: true, result: [] })),
    };
    const checks = PREFLIGHTS['build_kb']!(ctx);
    expect(checks.map((c) => c.id)).toEqual([...PREFLIGHT_CHECK_IDS]);

    expect(() => PREFLIGHTS['build_kb']!({ db, config })).toThrowError(
      expect.objectContaining({ code: 'validation_error' }),
    );
  });

  it('runPreflightFor: nieznany typ → {ok:true, checks:[]}; noop → checki lokalne', async () => {
    const config = makeTestConfig({ dataDir });
    expect(await runPreflightFor('typ_bez_preflightu', { db, config })).toEqual({ ok: true, checks: [] });

    const noop = await runPreflightFor('noop', { db, config });
    expect(noop.ok).toBe(true);
    expect(noop.checks.map((c) => c.id)).toEqual(['disk_space', 'dir_writable']);
  });
});
