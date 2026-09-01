import type { Db } from '../open.js';
import { nowIso } from '../open.js';
import { AppError } from '../../errors.js';
import { recordGap, type GapRow } from './learningGaps.js';
import { hex8, parseJson, ymd } from './util.js';

/** Rejestr odpowiedzi (diagnostyka jakości) + feedback z pętlą uczenia. */

export type AnswerSource = 'mcp' | 'panel' | 'api';
export type FeedbackVerdict = 'up' | 'down';

export interface AnswerRow {
  id: string;
  question: string;
  namespaces_json: string;
  citations_json: string;
  confidence: number | null;
  model: string | null;
  degraded: number;
  no_answer: number;
  source: AnswerSource;
  api_key_id: string | null;
  user_id: string | null;
  took_ms: number | null;
  created_at: string;
}

export interface FeedbackRow {
  id: string;
  answer_id: string;
  verdict: FeedbackVerdict;
  comment: string | null;
  created_by: string | null;
  created_at: string;
}

export interface AnswerInput {
  question: string;
  namespaces?: string[];
  citations?: { n: number; id: string; namespace: string }[];
  confidence?: number | null;
  model?: string | null;
  degraded?: boolean;
  noAnswer?: boolean;
  source: AnswerSource;
  apiKeyId?: string | null;
  userId?: string | null;
  tookMs?: number | null;
}

export function recordAnswer(db: Db, input: AnswerInput): AnswerRow {
  const id = `ans_${ymd()}_${hex8()}`;
  db.prepare(
    `INSERT INTO answers (id, question, namespaces_json, citations_json, confidence, model,
       degraded, no_answer, source, api_key_id, user_id, took_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.question,
    JSON.stringify(input.namespaces ?? []),
    JSON.stringify(input.citations ?? []),
    input.confidence ?? null,
    input.model ?? null,
    input.degraded ? 1 : 0,
    input.noAnswer ? 1 : 0,
    input.source,
    input.apiKeyId ?? null,
    input.userId ?? null,
    input.tookMs ?? null,
    nowIso(),
  );
  return getAnswerOrThrow(db, id);
}

export function getAnswer(db: Db, id: string): AnswerRow | null {
  const row = db.prepare('SELECT * FROM answers WHERE id = ?').get(id) as AnswerRow | undefined;
  return row ?? null;
}

export function getAnswerOrThrow(db: Db, id: string): AnswerRow {
  const row = getAnswer(db, id);
  if (!row) throw new AppError('not_found', `odpowiedź nie istnieje: ${id}`);
  return row;
}

export interface RecordFeedbackResult {
  feedback: FeedbackRow;
  /** Luka wiedzy utworzona/zaktualizowana automatycznie przy verdict='down'. */
  gap: GapRow | null;
}

/** Feedback do odpowiedzi; kciuk w dół → automatyczna luka (source 'feedback'). */
export function recordFeedback(
  db: Db,
  answerId: string,
  verdict: FeedbackVerdict,
  comment?: string | null,
  createdBy?: string | null,
): RecordFeedbackResult {
  const tx = db.transaction((): RecordFeedbackResult => {
    const answer = getAnswerOrThrow(db, answerId);
    const id = `fb_${hex8()}${hex8()}`;
    db.prepare(
      'INSERT INTO feedback (id, answer_id, verdict, comment, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, answerId, verdict, comment ?? null, createdBy ?? null, nowIso());
    let gap: GapRow | null = null;
    if (verdict === 'down') {
      const namespaces = parseJson<string[]>(answer.namespaces_json, []);
      gap = recordGap(db, {
        question: answer.question,
        source: 'feedback',
        kbNamespace: namespaces[0] ?? null,
        confidence: answer.confidence,
        apiKeyId: answer.api_key_id,
        metadata: { answerId, ...(comment ? { comment } : {}) },
      }).row;
    }
    const feedback = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as FeedbackRow;
    return { feedback, gap };
  });
  return tx.immediate();
}

export interface AnswerWithFeedback extends AnswerRow {
  feedback: FeedbackRow[];
}

/**
 * Ostatnie odpowiedzi danego użytkownika (panelowe /ask/history) wraz z jego
 * feedbackiem — jedna kwerenda na answers + jedna zbiorcza na feedback.
 */
export function listAnswersByUser(db: Db, userId: string, limit = 50): AnswerWithFeedback[] {
  const capped = Math.min(Math.max(limit, 1), 200);
  const rows = db
    .prepare('SELECT * FROM answers WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(userId, capped) as AnswerRow[];
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => '?').join(',');
  const feedback = db
    .prepare(`SELECT * FROM feedback WHERE answer_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`)
    .all(...rows.map((r) => r.id)) as FeedbackRow[];
  const byAnswer = new Map<string, FeedbackRow[]>();
  for (const f of feedback) {
    const list = byAnswer.get(f.answer_id);
    if (list === undefined) byAnswer.set(f.answer_id, [f]);
    else list.push(f);
  }
  return rows.map((r) => ({ ...r, feedback: byAnswer.get(r.id) ?? [] }));
}
