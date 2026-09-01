import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  cancelAction,
  failAction,
  finishAction,
  getActionWithLogTail,
  listActions,
  orphanSweep,
  setActionPid,
  startAction,
  updateActionProgress,
} from '../src/db/index.js';
import { testDb } from './helpers.js';

describe('repos/actions', () => {
  it('guard ux_actions_running: druga akcja (type,resource) → 409 action_already_running z actionId', () => {
    const db = testDb();
    const first = startAction(db, 'build_kb', 'kb:Test', {}, null, '/tmp/a.log');
    try {
      startAction(db, 'build_kb', 'kb:Test', {}, null, '/tmp/b.log');
      expect.unreachable('powinno rzucić');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.code).toBe('action_already_running');
      expect((e.details as { actionId: string }).actionId).toBe(first.id);
    }
    // inna para (type,resource) przechodzi
    expect(startAction(db, 'build_kb', 'kb:Other', {}, null, '/tmp/c.log').status).toBe('running');
    // po zakończeniu można wystartować ponownie
    finishAction(db, first.id);
    expect(startAction(db, 'build_kb', 'kb:Test', {}, null, '/tmp/d.log').status).toBe('running');
  });

  it('finish/fail/cancel tylko z running; progress zapisany', () => {
    const db = testDb();
    const a = startAction(db, 'analyze_draft', 'draft:x', { foo: 1 }, 'user_1', '/tmp/x.log');
    updateActionProgress(db, a.id, { phase: 'upload', current: 1, total: 3 });
    const done = finishAction(db, a.id, 0);
    expect(done.status).toBe('success');
    expect(done.finished_at).toBeTruthy();
    expect(JSON.parse(done.progress_json ?? '{}').phase).toBe('upload');
    expect(() => cancelAction(db, a.id)).toThrowError(/running/);
    expect(() => failAction(db, a.id)).toThrowError(/running/);
  });

  it('logTail czyta ostatnie bajty pliku logu', () => {
    const db = testDb();
    const dir = mkdtempSync(join(tmpdir(), 'kag-act-'));
    const logPath = join(dir, 'a.log');
    writeFileSync(logPath, 'poczatek\n' + 'x'.repeat(100) + '\nkoniec-loga\n');
    const a = startAction(db, 'export_drafts', 'kb:T', {}, null, logPath);
    const withTail = getActionWithLogTail(db, a.id, { logTailBytes: 20 });
    expect(withTail?.logTail).toContain('koniec-loga');
    expect(withTail?.logTail?.length).toBeLessThanOrEqual(20);
    // brak pliku → null, bez wyjątku
    const b = startAction(db, 'export_drafts', 'kb:U', {}, null, join(dir, 'missing.log'));
    expect(getActionWithLogTail(db, b.id)?.logTail).toBeNull();
  });

  it('orphanSweep: martwy pid lub brak pid → error', () => {
    const db = testDb();
    const dead = startAction(db, 'build_kb', 'kb:A', {}, null, '/tmp/a.log');
    setActionPid(db, dead.id, 99999);
    const alive = startAction(db, 'build_kb', 'kb:B', {}, null, '/tmp/b.log');
    setActionPid(db, alive.id, 1234);
    const noPid = startAction(db, 'build_kb', 'kb:C', {}, null, '/tmp/c.log');
    const swept = orphanSweep(db, (pid) => pid === 1234);
    expect(swept.sort()).toEqual([dead.id, noPid.id].sort());
    const { items } = listActions(db, { status: 'error' });
    expect(items.map((i) => i.id).sort()).toEqual([dead.id, noPid.id].sort());
    expect(listActions(db, { status: 'running' }).items.map((i) => i.id)).toEqual([alive.id]);
  });
});
