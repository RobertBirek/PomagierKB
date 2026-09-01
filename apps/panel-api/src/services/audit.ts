import type { Db } from '@pomagierkb/shared/db';

/**
 * Odczyt łańcucha audytu (tylko admin): filtry from/to/action/actor/outcome
 * + paginacja kursorem po seq (malejąco — najnowsze najpierw).
 * Weryfikację łańcucha robi verifyChain z shared/audit (routes/audit.ts).
 */

export interface AuditListFilter {
  /** ISO-8601 — wpisy z at >= from. */
  from?: string;
  /** ISO-8601 — wpisy z at <= to. */
  to?: string;
  action?: string;
  actor?: string;
  outcome?: string;
  /** Kursor: tylko wpisy o seq < beforeSeq (stronicowanie w dół). */
  beforeSeq?: number;
  limit?: number;
}

export interface AuditEntryView {
  seq: number;
  id: string;
  at: string;
  actor: string;
  actorType: string;
  role: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
}

interface AuditDbRow {
  seq: number;
  id: string;
  at: string;
  actor: string;
  actor_type: string;
  role: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  outcome: string;
  before_json: string | null;
  after_json: string | null;
  metadata_json: string | null;
}

function parseJsonOrNull(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // uszkodzony JSON pokazujemy surowo (verify i tak go zgłosi)
  }
}

export interface AuditListResult {
  items: AuditEntryView[];
  total: number;
  /** Kursor następnej strony (seq najstarszego zwróconego wpisu) — brak = koniec. */
  nextBeforeSeq?: number;
}

export function listAudit(db: Db, filter: AuditListFilter = {}): AuditListResult {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.from !== undefined) {
    where.push('at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    where.push('at <= ?');
    params.push(filter.to);
  }
  if (filter.action !== undefined) {
    where.push('action = ?');
    params.push(filter.action);
  }
  if (filter.actor !== undefined) {
    where.push('actor = ?');
    params.push(filter.actor);
  }
  if (filter.outcome !== undefined) {
    where.push('outcome = ?');
    params.push(filter.outcome);
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit ${cond}`).get(...params) as { n: number }).n;

  // Kursor po seq NIE wchodzi do COUNT (total = liczba pasujących do filtrów).
  const pageWhere = [...where];
  const pageParams = [...params];
  if (filter.beforeSeq !== undefined) {
    pageWhere.push('seq < ?');
    pageParams.push(filter.beforeSeq);
  }
  const pageCond = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : '';
  const limit = Math.min(filter.limit ?? 50, 200);
  const rows = db
    .prepare(
      `SELECT seq, id, at, actor, actor_type, role, action, resource_type, resource_id,
              outcome, before_json, after_json, metadata_json
       FROM audit ${pageCond} ORDER BY seq DESC LIMIT ?`,
    )
    .all(...pageParams, limit) as AuditDbRow[];

  const items = rows.map((r) => ({
    seq: r.seq,
    id: r.id,
    at: r.at,
    actor: r.actor,
    actorType: r.actor_type,
    role: r.role,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    outcome: r.outcome,
    before: parseJsonOrNull(r.before_json),
    after: parseJsonOrNull(r.after_json),
    metadata: parseJsonOrNull(r.metadata_json),
  }));

  const result: AuditListResult = { items, total };
  const last = items.at(-1);
  if (last !== undefined && items.length === limit) result.nextBeforeSeq = last.seq;
  return result;
}
