import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@pomagierkb/shared/db';
import { makeTestApp } from './admin-helpers.js';
import { insertIntake, updateIntake } from '../src/services/intakes.js';
import {
  RETENTION_DEFAULTS,
  readRetentionPolicy,
  runRetention,
  selectExpired,
} from '../src/services/retention.js';

let app: FastifyInstance;
let db: Db;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'kag-retention-test-'));
  ({ app, db } = await makeTestApp({ dataDir }));
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function oldFile(path: string, ageDays: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
  const t = new Date(Date.now() - ageDays * 86_400_000);
  utimesSync(path, t, t);
}

describe('retention', () => {
  it('selectExpired: pure — wybiera tylko starsze niż cutoff', () => {
    const now = Date.now();
    const files = [
      { path: '/a/stary.log', mtimeMs: now - 100 * 86_400_000 },
      { path: '/a/nowy.log', mtimeMs: now - 1 * 86_400_000 },
    ];
    expect(selectExpired(files, 90, now)).toEqual(['/a/stary.log']);
    expect(selectExpired(files, 200, now)).toEqual([]);
  });

  it("polityka z settings 'retention' nadpisuje domyślne (defensywnie)", () => {
    expect(readRetentionPolicy(db)).toEqual(RETENTION_DEFAULTS);
    db.prepare(
      "INSERT INTO settings (key, value_json, is_secret, updated_at) VALUES ('retention', ?, 0, datetime('now'))",
    ).run(JSON.stringify({ actionLogsDays: 10, exportsDays: 'zle' }));
    const p = readRetentionPolicy(db);
    expect(p.actionLogsDays).toBe(10);
    expect(p.exportsDays).toBe(RETENTION_DEFAULTS.exportsDays);
  });

  it('runRetention czyści stare logi/usage/eksporty i blob failed intake; audytuje', () => {
    const staryLog = join(dataDir, 'actions', '2026', '01', 'act_old.log');
    const nowyLog = join(dataDir, 'actions', '2026', '09', 'act_new.log');
    oldFile(staryLog, 120);
    oldFile(nowyLog, 1);
    const staryUsage = join(dataDir, 'mcp-usage', '2025-01-01.jsonl');
    oldFile(staryUsage, 400);
    const staryExport = join(dataDir, 'exports', 'KbX', '1');
    mkdirSync(staryExport, { recursive: true });
    writeFileSync(join(staryExport, 'chunk.csv'), 'x');
    const t = new Date(Date.now() - 60 * 86_400_000);
    utimesSync(staryExport, t, t);

    // failed intake sprzed 40 dni z blobem
    const blob = join(dataDir, 'uploads', 'aa', 'deadbeef');
    oldFile(blob, 40);
    const intake = insertIntake(db, { sourceKind: 'text', blobPath: blob });
    updateIntake(db, intake.id, { status: 'failed', error: 'internal' });
    db.prepare('UPDATE intakes SET updated_at = ? WHERE id = ?').run(
      new Date(Date.now() - 40 * 86_400_000).toISOString(),
      intake.id,
    );

    const result = runRetention(db, dataDir);
    expect(result.actionLogs).toBe(1);
    expect(result.mcpUsage).toBe(1);
    expect(result.exportDirs).toBe(1);
    expect(result.failedIntakeBlobs).toBe(1);
    expect(existsSync(staryLog)).toBe(false);
    expect(existsSync(nowyLog)).toBe(true);
    expect(existsSync(blob)).toBe(false);

    const audit = db
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'retention.purge'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });
});
