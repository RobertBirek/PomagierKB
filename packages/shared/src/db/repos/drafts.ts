import type { Db } from '../open.js';
import { nowIso } from '../open.js';
import { AppError } from '../../errors.js';
import { markDirty } from './kbRegistry.js';
import { hex8, sha256hex, slugify, ymdDashed } from './util.js';

/** Inbox draftów — JEDYNA droga zapisu wiedzy (human-in-the-loop). */

export type DraftStatus = 'pending' | 'promoted' | 'rejected' | 'withdrawn';
export type DraftSourceType = 'upload' | 'text' | 'api' | 'mcp' | 'gap';

export const DRAFT_LIMITS = {
  titleMax: 300,
  contentMax: 100_000,
  tagsMax: 10,
  perDay: 100,
} as const;

export interface DraftRow {
  id: string;
  namespace: string | null;
  status: DraftStatus;
  title: string;
  content_md: string;
  content_hash: string;
  content_length: number;
  source_type: DraftSourceType;
  source_ref: string | null;
  document_category: string | null;
  tags_json: string;
  metadata_json: string;
  analysis_json: string | null;
  reject_reason: string | null;
  submitted_by_user: string | null;
  submitted_by_key: string | null;
  created_at: string;
  updated_at: string;
  decided_by: string | null;
  decided_at: string | null;
  promoted_at: string | null;
}

export interface DraftCreateInput {
  title: string;
  content: string;
  sourceType: DraftSourceType;
  namespace?: string | null;
  sourceRef?: string | null;
  documentCategory?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  analysis?: Record<string, unknown> | null;
  submittedByUser?: string | null;
  submittedByKey?: string | null;
}

function validateCreate(input: DraftCreateInput): void {
  if (!input.title.trim()) throw new AppError('validation_error', 'title jest wymagany');
  if (input.title.length > DRAFT_LIMITS.titleMax) {
    throw new AppError('validation_error', `title przekracza ${DRAFT_LIMITS.titleMax} znaków`);
  }
  if (input.content.length > DRAFT_LIMITS.contentMax) {
    throw new AppError('payload_too_large', `content przekracza ${DRAFT_LIMITS.contentMax} znaków`);
  }
  if ((input.tags?.length ?? 0) > DRAFT_LIMITS.tagsMax) {
    throw new AppError('validation_error', `maksymalnie ${DRAFT_LIMITS.tagsMax} tagów`);
  }
}

/** Liczba draftów utworzonych dziś (UTC) — pod limit dzienny. */
function countToday(db: Db): number {
  const dayStart = `${ymdDashed()}T00:00:00.000Z`;
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM drafts WHERE created_at >= ?')
    .get(dayStart) as { n: number };
  return row.n;
}

export function createDraft(db: Db, input: DraftCreateInput): DraftRow {
  validateCreate(input);
  const tx = db.transaction(() => {
    if (countToday(db) >= DRAFT_LIMITS.perDay) {
      throw new AppError('rate_limited', `limit dzienny draftów wyczerpany (${DRAFT_LIMITS.perDay}/dzień)`);
    }
    const now = nowIso();
    const id = `draft_${ymdDashed()}_${hex8()}_${slugify(input.title)}`;
    db.prepare(
      `INSERT INTO drafts (id, namespace, status, title, content_md, content_hash, content_length,
         source_type, source_ref, document_category, tags_json, metadata_json, analysis_json,
         submitted_by_user, submitted_by_key, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.namespace ?? null,
      input.title,
      input.content,
      sha256hex(input.content),
      input.content.length,
      input.sourceType,
      input.sourceRef ?? null,
      input.documentCategory ?? null,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.metadata ?? {}),
      input.analysis ? JSON.stringify(input.analysis) : null,
      input.submittedByUser ?? null,
      input.submittedByKey ?? null,
      now,
      now,
    );
    return getDraftOrThrow(db, id);
  });
  return tx.immediate();
}

/** Idempotencja submitów: ten sam content w tym samym namespace → istniejący draft. */
export function findByContentHash(db: Db, namespace: string | null, hash: string): DraftRow | null {
  const row = db
    .prepare('SELECT * FROM drafts WHERE namespace IS ? AND content_hash = ? ORDER BY created_at DESC LIMIT 1')
    .get(namespace, hash) as DraftRow | undefined;
  return row ?? null;
}

export function getDraft(db: Db, id: string): DraftRow | null {
  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
  return row ?? null;
}

export function getDraftOrThrow(db: Db, id: string): DraftRow {
  const row = getDraft(db, id);
  if (!row) throw new AppError('not_found', `draft nie istnieje: ${id}`);
  return row;
}

export interface DraftListFilter {
  status?: DraftStatus;
  namespace?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export function listDrafts(db: Db, filter: DraftListFilter = {}): { items: DraftRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.namespace) {
    where.push('namespace = ?');
    params.push(filter.namespace);
  }
  if (filter.q) {
    where.push('title LIKE ? ESCAPE \'\\\'');
    params.push(`%${filter.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM drafts ${cond}`).get(...params) as { n: number }).n;
  const items = db
    .prepare(`SELECT * FROM drafts ${cond} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.min(filter.limit ?? 50, 200), filter.offset ?? 0) as DraftRow[];
  return { items, total };
}

export interface DraftPatch {
  title?: string;
  tags?: string[];
  namespace?: string | null;
  documentCategory?: string | null;
}

/** Edycja metadanych — dozwolona wyłącznie dla statusu pending. */
export function updatePending(db: Db, id: string, patch: DraftPatch): DraftRow {
  if (patch.title !== undefined && (patch.title.length > DRAFT_LIMITS.titleMax || !patch.title.trim())) {
    throw new AppError('validation_error', `title pusty lub przekracza ${DRAFT_LIMITS.titleMax} znaków`);
  }
  if (patch.tags !== undefined && patch.tags.length > DRAFT_LIMITS.tagsMax) {
    throw new AppError('validation_error', `maksymalnie ${DRAFT_LIMITS.tagsMax} tagów`);
  }
  const tx = db.transaction(() => {
    const row = getDraftOrThrow(db, id);
    if (row.status !== 'pending') {
      throw new AppError('conflict', `draft nie jest pending (status: ${row.status})`);
    }
    db.prepare(
      `UPDATE drafts SET title = ?, tags_json = ?, namespace = ?, document_category = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.title ?? row.title,
      patch.tags !== undefined ? JSON.stringify(patch.tags) : row.tags_json,
      patch.namespace !== undefined ? patch.namespace : row.namespace,
      patch.documentCategory !== undefined ? patch.documentCategory : row.document_category,
      nowIso(),
      id,
    );
    return getDraftOrThrow(db, id);
  });
  return tx.immediate();
}

function decide(
  db: Db,
  id: string,
  from: DraftStatus,
  to: DraftStatus,
  decidedBy: string,
  extra?: { rejectReason?: string | null; setPromotedAt?: boolean },
): DraftRow {
  const tx = db.transaction(() => {
    const row = getDraftOrThrow(db, id);
    if (row.status !== from) {
      throw new AppError('conflict', `nielegalne przejście draftu: ${row.status} → ${to}`, {
        from: row.status,
        to,
      });
    }
    const now = nowIso();
    db.prepare(
      `UPDATE drafts SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?,
         reject_reason = ?, promoted_at = ? WHERE id = ?`,
    ).run(
      to,
      decidedBy,
      now,
      now,
      extra?.rejectReason ?? row.reject_reason,
      extra?.setPromotedAt ? now : row.promoted_at,
      id,
    );
    // Promocja/withdraw zmienia zawartość przyszłego builda → KB oznaczany jako dirty.
    if ((to === 'promoted' || to === 'withdrawn') && row.namespace) markDirty(db, row.namespace);
    return getDraftOrThrow(db, id);
  });
  return tx.immediate();
}

export function promoteDraft(db: Db, id: string, decidedBy: string): DraftRow {
  const row = getDraftOrThrow(db, id);
  if (!row.namespace) {
    throw new AppError('conflict', 'draft bez przypisanego namespace nie może być promowany');
  }
  return decide(db, id, 'pending', 'promoted', decidedBy, { setPromotedAt: true });
}

export function rejectDraft(db: Db, id: string, decidedBy: string, reason?: string): DraftRow {
  return decide(db, id, 'pending', 'rejected', decidedBy, { rejectReason: reason ?? null });
}

/** Cofnięcie promocji przed buildem — tylko z promoted. */
export function withdrawDraft(db: Db, id: string, decidedBy: string): DraftRow {
  return decide(db, id, 'promoted', 'withdrawn', decidedBy);
}

export type BulkOp = 'promote' | 'reject';
export type BulkDryRunResult = { id: string; ok: true } | { id: string; ok: false; reason: string };

/** Dwufazowy bulk: raport per id bez wykonywania zmian. */
export function bulkDryRun(db: Db, op: BulkOp, ids: string[]): BulkDryRunResult[] {
  return ids.map((id) => {
    const row = getDraft(db, id);
    if (!row) return { id, ok: false, reason: 'not_found' };
    if (row.status !== 'pending') return { id, ok: false, reason: `conflict: status ${row.status}` };
    if (op === 'promote' && !row.namespace) return { id, ok: false, reason: 'conflict: brak namespace' };
    return { id, ok: true };
  });
}

export function draftTags(row: DraftRow): string[] {
  try {
    return JSON.parse(row.tags_json) as string[];
  } catch {
    return [];
  }
}
