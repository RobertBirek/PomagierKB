import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, WAL_SIZE_LIMIT_BYTES, type Db } from '../src/db/open.js';

/**
 * openDb: pragmy współdzielenia bazy oraz limit rozmiaru pliku WAL. Bez limitu plik -wal
 * zostaje na zawsze przy największym rozmiarze, jaki osiągnął (produkcja 2026-10-05:
 * 248 MB po jednej dużej transakcji, przy 1,3 MB żywych ramek).
 */
describe('openDb', () => {
  let dir: string | null = null;
  let db: Db | null = null;
  afterEach(() => {
    db?.close();
    db = null;
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('ustawia WAL, busy_timeout, foreign_keys i limit rozmiaru dziennika', () => {
    dir = mkdtempSync(join(tmpdir(), 'kag-open-'));
    db = openDb(join(dir, 'kag.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_size_limit', { simple: true })).toBe(WAL_SIZE_LIMIT_BYTES);
    expect(WAL_SIZE_LIMIT_BYTES).toBe(64 * 1024 * 1024);
  });

  /** Jedna transakcja ~8 MB, pasywny checkpoint, kolejny zapis → rozmiar pliku -wal. */
  function walSizeAfterBigTransaction(path: string, limitBytes: number): { grown: number; after: number } {
    const d = openDb(path);
    try {
      d.pragma(`journal_size_limit = ${limitBytes}`);
      d.pragma('wal_autocheckpoint = 0'); // checkpoint wyłącznie jawny, żeby WAL urósł
      d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob BLOB)');
      const insert = d.prepare('INSERT INTO t (blob) VALUES (?)');
      const big = Buffer.alloc(64 * 1024, 7);
      d.transaction(() => {
        for (let i = 0; i < 128; i++) insert.run(big);
      })();
      const grown = statSync(`${path}-wal`).size;
      d.pragma('wal_checkpoint(PASSIVE)'); // jak autocheckpoint: przenosi ramki, pliku nie skraca
      insert.run(Buffer.alloc(16, 1)); // kolejny zapis zaczyna dziennik od początku
      return { grown, after: statSync(`${path}-wal`).size };
    } finally {
      d.close();
    }
  }

  it('z limitem plik -wal po dużej transakcji wraca do limitu; bez limitu zostaje duży', () => {
    dir = mkdtempSync(join(tmpdir(), 'kag-open-'));
    const limited = walSizeAfterBigTransaction(join(dir, 'limited.db'), 1048576);
    expect(limited.grown).toBeGreaterThan(4 * 1024 * 1024);
    expect(limited.after).toBeLessThanOrEqual(1048576);

    const unlimited = walSizeAfterBigTransaction(join(dir, 'unlimited.db'), -1);
    expect(unlimited.after).toBe(unlimited.grown); // dowód, że to limit skraca plik
  });

  it('baza w pamięci nie wymaga katalogu ani limitu', () => {
    db = openDb(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
