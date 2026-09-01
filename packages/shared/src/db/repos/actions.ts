import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import type { Db } from '../open.js';
import { nowIso } from '../open.js';
import { AppError } from '../../errors.js';
import { hex8, isConstraintError, ymd } from './util.js';

/** Długobieżne akcje (spawn + 202 + SSE); guard idempotencji przez ux_actions_running. */

export type ActionStatus = 'running' | 'success' | 'error' | 'cancelled';

export interface ActionRow {
  id: string;
  type: string;
  resource: string;
  status: ActionStatus;
  params_json: string;
  progress_json: string | null;
  started_by: string | null;
  pid: number | null;
  exit_code: number | null;
  log_path: string;
  started_at: string;
  finished_at: string | null;
}

export interface ActionProgress {
  phase?: string;
  current?: number;
  total?: number;
  message?: string;
}

/**
 * Start akcji: INSERT w transakcji IMMEDIATE. Druga akcja tego samego (type,resource)
 * w stanie running → SQLITE_CONSTRAINT na ux_actions_running → 409 action_already_running
 * z details.actionId istniejącej (idempotencja bez wyścigów).
 */
export function startAction(
  db: Db,
  type: string,
  resource: string,
  params: Record<string, unknown>,
  startedBy: string | null,
  logPath: string,
): ActionRow {
  const id = `act_${ymd()}_${hex8()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO actions (id, type, resource, status, params_json, started_by, log_path, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(id, type, resource, JSON.stringify(params), startedBy, logPath, nowIso());
  });
  try {
    tx.immediate();
  } catch (err) {
    if (isConstraintError(err)) {
      const existing = db
        .prepare("SELECT id FROM actions WHERE type = ? AND resource = ? AND status = 'running'")
        .get(type, resource) as { id: string } | undefined;
      throw new AppError('action_already_running', `akcja ${type} na ${resource} już trwa`, {
        actionId: existing?.id ?? null,
      });
    }
    throw err;
  }
  return getActionOrThrow(db, id);
}

/** Zapis pid procesu potomnego po spawn(). */
export function setActionPid(db: Db, id: string, pid: number): void {
  db.prepare('UPDATE actions SET pid = ? WHERE id = ?').run(pid, id);
}

function terminate(db: Db, id: string, to: ActionStatus, exitCode: number | null): ActionRow {
  const tx = db.transaction(() => {
    const row = getActionOrThrow(db, id);
    if (row.status !== 'running') {
      throw new AppError('conflict', `akcja nie jest running (status: ${row.status})`);
    }
    db.prepare('UPDATE actions SET status = ?, exit_code = ?, finished_at = ? WHERE id = ?').run(
      to,
      exitCode,
      nowIso(),
      id,
    );
    return getActionOrThrow(db, id);
  });
  return tx.immediate();
}

export function finishAction(db: Db, id: string, exitCode = 0): ActionRow {
  return terminate(db, id, 'success', exitCode);
}

export function failAction(db: Db, id: string, exitCode: number | null = 1): ActionRow {
  return terminate(db, id, 'error', exitCode);
}

export function cancelAction(db: Db, id: string): ActionRow {
  return terminate(db, id, 'cancelled', null);
}

export function updateActionProgress(db: Db, id: string, progress: ActionProgress): void {
  const res = db
    .prepare("UPDATE actions SET progress_json = ? WHERE id = ? AND status = 'running'")
    .run(JSON.stringify(progress), id);
  if (res.changes === 0) {
    const row = getAction(db, id);
    if (!row) throw new AppError('not_found', `akcja nie istnieje: ${id}`);
    // Akcja zakończona — progress ignorowany (spóźniony zapis dziecka), bez błędu.
  }
}

export function getAction(db: Db, id: string): ActionRow | null {
  const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as ActionRow | undefined;
  return row ?? null;
}

export function getActionOrThrow(db: Db, id: string): ActionRow {
  const row = getAction(db, id);
  if (!row) throw new AppError('not_found', `akcja nie istnieje: ${id}`);
  return row;
}

/** Ostatnie maxBytes pliku logu (dla logTail); brak pliku → null. */
export function readLogTail(logPath: string, maxBytes = 16_384): string | null {
  let fd: number;
  try {
    fd = openSync(logPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function getActionWithLogTail(
  db: Db,
  id: string,
  opts: { logTailBytes?: number } = {},
): (ActionRow & { logTail: string | null }) | null {
  const row = getAction(db, id);
  if (!row) return null;
  return { ...row, logTail: readLogTail(row.log_path, opts.logTailBytes ?? 16_384) };
}

export interface ActionListFilter {
  status?: ActionStatus;
  type?: string;
  resource?: string;
  limit?: number;
  offset?: number;
}

export function listActions(db: Db, filter: ActionListFilter = {}): { items: ActionRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.type) {
    where.push('type = ?');
    params.push(filter.type);
  }
  if (filter.resource) {
    where.push('resource = ?');
    params.push(filter.resource);
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM actions ${cond}`).get(...params) as { n: number }).n;
  const items = db
    .prepare(`SELECT * FROM actions ${cond} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.min(filter.limit ?? 50, 200), filter.offset ?? 0) as ActionRow[];
  return { items, total };
}

/**
 * Sprzątanie osieroconych akcji przy starcie procesu: running z martwym pid
 * (lub bez pid — dziecko padło przed zapisem) → error. Zwraca id posprzątanych.
 */
export function orphanSweep(db: Db, isAlive: (pid: number) => boolean): string[] {
  const swept: string[] = [];
  const tx = db.transaction(() => {
    const running = db.prepare("SELECT id, pid FROM actions WHERE status = 'running'").all() as {
      id: string;
      pid: number | null;
    }[];
    for (const a of running) {
      if (a.pid !== null && isAlive(a.pid)) continue;
      db.prepare("UPDATE actions SET status = 'error', finished_at = ? WHERE id = ?").run(nowIso(), a.id);
      swept.push(a.id);
    }
  });
  tx.immediate();
  return swept;
}
