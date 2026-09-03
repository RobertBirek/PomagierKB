import type { Db } from '../open.js';
import { nowIso } from '../open.js';
import { AppError } from '../../errors.js';
import { hex8, isConstraintError, ymd } from './util.js';

/** Luki wiedzy: pytania bez dobrej odpowiedzi → materiał na drafty (pętla uczenia). */

export type GapStatus = 'open' | 'in_draft' | 'resolved' | 'ignored';
export type GapSource = 'mcp' | 'panel' | 'feedback';

export interface GapRow {
  id: string;
  question: string;
  normalized_question: string;
  source: GapSource;
  kb_namespace: string | null;
  confidence: number | null;
  evidence_count: number;
  answer_preview: string | null;
  api_key_id: string | null;
  status: GapStatus;
  draft_id: string | null;
  metadata_json: string;
  created_at: string;
  processed_at: string | null;
  processed_by: string | null;
}

/** Normalizacja pytania: lowercase, bez interpunkcji, pojedyncze spacje. */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRANSITIONS: Record<GapStatus, GapStatus[]> = {
  open: ['in_draft', 'resolved', 'ignored'],
  in_draft: ['resolved', 'ignored'],
  // reopen (program rozbudowy F8): ignore/resolve przestają być nieodwracalne
  resolved: ['open'],
  ignored: ['open'],
};

export interface GapInput {
  question: string;
  source: GapSource;
  kbNamespace?: string | null;
  confidence?: number | null;
  answerPreview?: string | null;
  apiKeyId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RecordGapResult {
  row: GapRow;
  /** false = istniała już otwarta luka o tym samym znormalizowanym pytaniu. */
  created: boolean;
}

/**
 * Duplikat otwartej luki (po normalized_question W OBRĘBIE namespace — migracja 0005;
 * wcześniej dedupe był globalny i to samo pytanie do dwóch KB zlewało się w jedną lukę)
 * → zwróć istniejącą, podbij evidence_count.
 */
export function recordGap(db: Db, input: GapInput): RecordGapResult {
  const normalized = normalizeQuestion(input.question);
  if (!normalized) throw new AppError('validation_error', 'question jest puste po normalizacji');
  const ns = input.kbNamespace ?? null;
  const tx = db.transaction((): RecordGapResult => {
    const existing = db
      .prepare(
        "SELECT * FROM learning_gaps WHERE normalized_question = ? AND status = 'open' AND kb_namespace IS ?",
      )
      .get(normalized, ns) as GapRow | undefined;
    if (existing) {
      db.prepare('UPDATE learning_gaps SET evidence_count = evidence_count + 1 WHERE id = ?').run(
        existing.id,
      );
      return { row: getGapOrThrow(db, existing.id), created: false };
    }
    const id = `gap_${ymd()}_${hex8()}`;
    try {
      db.prepare(
        `INSERT INTO learning_gaps (id, question, normalized_question, source, kb_namespace,
           confidence, evidence_count, answer_preview, api_key_id, status, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'open', ?, ?)`,
      ).run(
        id,
        input.question,
        normalized,
        input.source,
        input.kbNamespace ?? null,
        input.confidence ?? null,
        input.answerPreview ? input.answerPreview.slice(0, 500) : null,
        input.apiKeyId ?? null,
        JSON.stringify(input.metadata ?? {}),
        nowIso(),
      );
    } catch (err) {
      // Wyścig na ux_gaps_open_dedupe (drugi proces wstawił równolegle) → zwróć istniejącą.
      if (isConstraintError(err)) {
        const raced = db
          .prepare(
            "SELECT * FROM learning_gaps WHERE normalized_question = ? AND status = 'open' AND kb_namespace IS ?",
          )
          .get(normalized, ns) as GapRow | undefined;
        if (raced) return { row: raced, created: false };
      }
      throw err;
    }
    return { row: getGapOrThrow(db, id), created: true };
  });
  return tx.immediate();
}

export function getGap(db: Db, id: string): GapRow | null {
  const row = db.prepare('SELECT * FROM learning_gaps WHERE id = ?').get(id) as GapRow | undefined;
  return row ?? null;
}

export function getGapOrThrow(db: Db, id: string): GapRow {
  const row = getGap(db, id);
  if (!row) throw new AppError('not_found', `luka nie istnieje: ${id}`);
  return row;
}

export interface GapListFilter {
  status?: GapStatus;
  kbNamespace?: string;
  /** 'evidence' = najczęściej dopytywane najpierw; default 'created' (najnowsze). */
  sort?: 'created' | 'evidence';
  limit?: number;
  offset?: number;
}

export function listGaps(db: Db, filter: GapListFilter = {}): { items: GapRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.kbNamespace) {
    where.push('kb_namespace = ?');
    params.push(filter.kbNamespace);
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM learning_gaps ${cond}`).get(...params) as {
    n: number;
  }).n;
  const order =
    filter.sort === 'evidence' ? 'evidence_count DESC, created_at DESC' : 'created_at DESC';
  const items = db
    .prepare(`SELECT * FROM learning_gaps ${cond} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, Math.min(filter.limit ?? 50, 200), filter.offset ?? 0) as GapRow[];
  return { items, total };
}

export function gapStats(db: Db): Record<GapStatus, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM learning_gaps GROUP BY status')
    .all() as { status: GapStatus; n: number }[];
  const stats: Record<GapStatus, number> = { open: 0, in_draft: 0, resolved: 0, ignored: 0 };
  for (const r of rows) stats[r.status] = r.n;
  return stats;
}

/** Przejście statusu luki; in_draft wymaga draftId. Nielegalne → 409 conflict. */
export function setGapStatus(
  db: Db,
  id: string,
  to: GapStatus,
  opts: { draftId?: string; processedBy?: string } = {},
): GapRow {
  const tx = db.transaction(() => {
    const row = getGapOrThrow(db, id);
    if (!TRANSITIONS[row.status].includes(to)) {
      throw new AppError('conflict', `nielegalne przejście luki: ${row.status} → ${to}`, {
        from: row.status,
        to,
      });
    }
    if (to === 'in_draft' && !opts.draftId) {
      throw new AppError('validation_error', 'przejście do in_draft wymaga draftId');
    }
    db.prepare(
      'UPDATE learning_gaps SET status = ?, draft_id = ?, processed_at = ?, processed_by = ? WHERE id = ?',
    ).run(to, opts.draftId ?? row.draft_id, nowIso(), opts.processedBy ?? null, id);
    return getGapOrThrow(db, id);
  });
  return tx.immediate();
}

/**
 * Reopen (ignored|resolved → open). Kolizja z JUŻ otwartą luką o tym samym
 * znormalizowanym pytaniu i namespace → merge: otwarta przejmuje evidence_count
 * reopenowanej, reopenowana zostaje w stanie terminalnym (zwracamy przetrwałą).
 */
export function reopenGap(db: Db, id: string, processedBy?: string): GapRow {
  const tx = db.transaction((): GapRow => {
    const row = getGapOrThrow(db, id);
    if (!TRANSITIONS[row.status].includes('open')) {
      throw new AppError('conflict', `nielegalne przejście luki: ${row.status} → open`, {
        from: row.status,
        to: 'open',
      });
    }
    const openTwin = db
      .prepare(
        "SELECT * FROM learning_gaps WHERE normalized_question = ? AND status = 'open' AND kb_namespace IS ? AND id != ?",
      )
      .get(row.normalized_question, row.kb_namespace, id) as GapRow | undefined;
    if (openTwin) {
      db.prepare('UPDATE learning_gaps SET evidence_count = evidence_count + ? WHERE id = ?').run(
        row.evidence_count,
        openTwin.id,
      );
      return getGapOrThrow(db, openTwin.id);
    }
    db.prepare(
      'UPDATE learning_gaps SET status = ?, processed_at = ?, processed_by = ? WHERE id = ?',
    ).run('open', nowIso(), processedBy ?? null, id);
    return getGapOrThrow(db, id);
  });
  return tx.immediate();
}

/** Auto-resolve po promocji draftu: wszystkie luki in_draft wskazujące draft → resolved. */
export function resolveByDraft(db: Db, draftId: string, processedBy?: string): number {
  return db
    .prepare(
      `UPDATE learning_gaps SET status = 'resolved', processed_at = ?, processed_by = ?
       WHERE draft_id = ? AND status = 'in_draft'`,
    )
    .run(nowIso(), processedBy ?? 'system', draftId).changes;
}
