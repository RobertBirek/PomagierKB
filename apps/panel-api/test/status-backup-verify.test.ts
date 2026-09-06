import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, as } from './admin-helpers.js';
import { parseVerifyReport, readLatestVerifyReport } from '../src/services/status.js';

/**
 * Sonda 'backup-verify' (ustalenie D5-04): kokpit świecił na zielono przez cztery
 * dni, w których cotygodniowy test odtwarzalności backupu kończył się błędem —
 * sonda backupu oceniała WYŁĄCZNIE świeżość snapshotu.
 */

const REPORT_OK = JSON.stringify({
  ok: true,
  checkedAt: new Date().toISOString(),
  snapshotDir: '/srv/kag-data/backups/nightly/2026-09-06_032942',
  checks: [
    { name: 'sha256sums', ok: true, detail: 'wszystkie sumy zgodne' },
    { name: 'mysql_restore', ok: true, detail: 'restore OK, tabel w openspg: 34' },
  ],
});

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kag-verify-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseVerifyReport', () => {
  it('czyta kształt raportu verify_backup.sh (ok + checks[])', () => {
    const parsed = parseVerifyReport(REPORT_OK);
    expect(parsed?.ok).toBe(true);
    expect(parsed?.failed).toEqual([]);
    expect(parsed?.checkedAt).not.toBeNull();
  });

  it('wyciąga nazwy nieudanych checków', () => {
    const parsed = parseVerifyReport(
      JSON.stringify({
        ok: false,
        checkedAt: '2026-09-06T04:39:42+02:00',
        checks: [
          { name: 'sha256sums', ok: true },
          { name: 'mysql_restore', ok: false, detail: 'restore nie przeszedł' },
        ],
      }),
    );
    expect(parsed?.ok).toBe(false);
    expect(parsed?.failed).toEqual(['mysql_restore']);
  });

  it('akceptuje też skrócony kształt {ok, checkedAt, failed[]}', () => {
    const parsed = parseVerifyReport(JSON.stringify({ ok: false, checkedAt: '2026-09-06T04:39:42Z', failed: ['sqlite_integrity'] }));
    expect(parsed?.failed).toEqual(['sqlite_integrity']);
  });

  it('śmieci → null (sonda nie może wywrócić kokpitu)', () => {
    expect(parseVerifyReport('to nie jest json')).toBeNull();
  });
});

describe('readLatestVerifyReport', () => {
  it('brak jakiegokolwiek raportu → null', () => {
    expect(readLatestVerifyReport(tempDataDir())).toBeNull();
  });

  it('preferuje podsumowanie backup-verify-status.json', () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, 'backup-verify-status.json'), REPORT_OK);
    expect(readLatestVerifyReport(dir)?.ok).toBe(true);
  });

  it('bez podsumowania bierze NAJNOWSZY raport z backups/verify (stempel w nazwie)', () => {
    const dir = tempDataDir();
    const verifyDir = join(dir, 'backups', 'verify');
    mkdirSync(verifyDir, { recursive: true });
    writeFileSync(
      join(verifyDir, 'verify-2026-09-03_124013.json'),
      JSON.stringify({ ok: true, checkedAt: '2026-09-03T12:40:13Z', checks: [] }),
    );
    writeFileSync(
      join(verifyDir, 'verify-2026-09-06_043942.json'),
      JSON.stringify({ ok: false, checkedAt: '2026-09-06T04:39:42Z', checks: [{ name: 'mysql_restore', ok: false }] }),
    );
    const latest = readLatestVerifyReport(dir);
    expect(latest?.ok).toBe(false);
    expect(latest?.failed).toEqual(['mysql_restore']);
  });
});

describe('sonda backup-verify w kokpicie', () => {
  it('ok=false → komponent down i overall down (kokpit widzi czerwoną weryfikację)', async () => {
    const dataDir = tempDataDir();
    writeFileSync(
      join(dataDir, 'backup-verify-status.json'),
      JSON.stringify({
        ok: false,
        checkedAt: new Date().toISOString(),
        checks: [{ name: 'mysql_restore', ok: false, detail: 'restore nie przeszedł' }],
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const ctx = await makeTestApp({ dataDir });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/status', headers: as('viewer') });
      const data = res.json().data as { overall: string; components: { id: string; status: string; detail: string }[] };
      const verify = data.components.find((c) => c.id === 'backup-verify');
      expect(verify?.status).toBe('down');
      expect(verify?.detail).toContain('mysql_restore');
      expect(data.overall).toBe('down');
    } finally {
      vi.unstubAllGlobals();
      await ctx.app.close();
      ctx.db.close();
    }
  });

  it('raport starszy niż 8 dni → warn (weryfikacja przestała biegać)', async () => {
    const dataDir = tempDataDir();
    writeFileSync(
      join(dataDir, 'backup-verify-status.json'),
      JSON.stringify({ ok: true, checkedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(), checks: [] }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const ctx = await makeTestApp({ dataDir });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/status', headers: as('viewer') });
      const data = res.json().data as { components: { id: string; status: string }[] };
      expect(data.components.find((c) => c.id === 'backup-verify')?.status).toBe('warn');
    } finally {
      vi.unstubAllGlobals();
      await ctx.app.close();
      ctx.db.close();
    }
  });

  it('brak raportu → unknown i NIE obniża overall (świeża instalacja)', async () => {
    const dataDir = tempDataDir();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const ctx = await makeTestApp({ dataDir });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/status', headers: as('viewer') });
      const data = res.json().data as { overall: string; components: { id: string; status: string }[] };
      expect(data.components.find((c) => c.id === 'backup-verify')?.status).toBe('unknown');
      expect(data.overall).not.toBe('unknown');
    } finally {
      vi.unstubAllGlobals();
      await ctx.app.close();
      ctx.db.close();
    }
  });
});
