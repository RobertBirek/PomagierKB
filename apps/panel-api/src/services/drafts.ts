import type { Db } from '@pomagierkb/shared/db';
import { parseLessonFrontmatter } from '../pipeline/frontmatter.js';
import {
  bulkDryRun,
  draftTags,
  getDraft,
  getDraftOrThrow,
  getKb,
  listDrafts,
  promoteDraft,
  rejectDraft,
  resolveByDraft,
  updatePending,
  withdrawDraft,
  type BulkOp,
  type DraftRow,
  type DraftStatus,
} from '@pomagierkb/shared/db';
import { AppError, type ErrorCode } from '@pomagierkb/shared/errors';
import { humanize } from './messages.js';

/**
 * Serwis Inboxu draftów (human-in-the-loop) — logika tras /api/v1/drafts.
 * Przejścia statusów i dirty=1 egzekwuje repo shared (drafts.ts: decide()
 * woła markDirty przy promote/withdraw) — tu tylko warstwa API:
 * widoki camelCase, walidacja KB active, bulk dwufazowy, auto-resolve luk.
 */

/** JSON.parse z fallbackiem — kolumny *_json nie mogą wywrócić odpowiedzi. */
function safeParse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Widok listowy draftu (bez treści — ta tylko w detalu). */
export function draftToListItem(row: DraftRow): Record<string, unknown> {
  return {
    id: row.id,
    namespace: row.namespace,
    status: row.status,
    statusLabel: humanize(row.status).label,
    title: row.title,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    documentCategory: row.document_category,
    tags: draftTags(row),
    contentLength: row.content_length,
    rejectReason: row.reject_reason,
    submittedByUser: row.submitted_by_user,
    submittedByKey: row.submitted_by_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    promotedAt: row.promoted_at,
    // Lekcje z sesji agentów (docs/lessons-convention.md): front-matter draftów mcp
    // parsowany do chipa w Inboxie; null = zwykły draft.
    lesson: row.source_type === 'mcp' ? parseLessonFrontmatter(row.content_md) : null,
  };
}

/** Widok szczegółowy: pełna treść + analysis + metadata + ludzki status. */
export function draftToDetail(row: DraftRow): Record<string, unknown> {
  return {
    ...draftToListItem(row),
    contentMd: row.content_md,
    contentHash: row.content_hash,
    analysis: safeParse<Record<string, unknown> | null>(row.analysis_json, null),
    metadata: safeParse<Record<string, unknown>>(row.metadata_json, {}),
    statusHuman: humanize(row.status),
  };
}

export interface DraftListQuery {
  status?: DraftStatus;
  namespace?: string;
  q?: string;
  tag?: string;
  page: number;
  limit: number;
}

export function listDraftEntries(
  db: Db,
  query: DraftListQuery,
): { items: Record<string, unknown>[]; total: number } {
  const { items, total } = listDrafts(db, {
    ...(query.status !== undefined && { status: query.status }),
    ...(query.namespace !== undefined && { namespace: query.namespace }),
    ...(query.q !== undefined && { q: query.q }),
    ...(query.tag !== undefined && { tag: query.tag }),
    limit: query.limit,
    offset: (query.page - 1) * query.limit,
  });
  return { items: items.map(draftToListItem), total };
}

/**
 * Walidacja "namespace wskazuje AKTYWNĄ bazę" — wspólna dla PATCH (400)
 * i promote (409). Komunikaty PL (koperta błędu idzie wprost do UI).
 */
export function assertKbActive(db: Db, namespace: string, code: ErrorCode): void {
  const kb = getKb(db, namespace);
  if (kb === null) {
    throw new AppError(code, `baza wiedzy ${namespace} nie istnieje`, { namespace });
  }
  if (kb.status !== 'active') {
    throw new AppError(
      code,
      `baza wiedzy ${namespace} nie jest aktywna (status: ${kb.status}) — najpierw ukończ provisioning bazy`,
      { namespace, kbStatus: kb.status },
    );
  }
}

export interface DraftApiPatch {
  title?: string;
  tags?: string[];
  namespace?: string;
  documentCategory?: string | null;
}

/** Edycja metadanych pending draftu; nowy namespace musi być aktywną bazą. */
export function patchDraftEntry(
  db: Db,
  id: string,
  patch: DraftApiPatch,
): { before: DraftRow; after: DraftRow } {
  if (patch.namespace !== undefined) assertKbActive(db, patch.namespace, 'validation_error');
  const before = getDraftOrThrow(db, id);
  const after = updatePending(db, id, patch); // repo: tylko pending, inaczej 409
  return { before, after };
}

/**
 * Promocja draftu: 409 gdy nie pending LUB KB nie active (komunikat PL).
 * dirty=1 ustawia repo (decide→markDirty). Po promocji auto-resolve luk
 * wiedzy wskazujących ten draft (learningGaps.resolveByDraft).
 */
export function promoteDraftEntry(
  db: Db,
  id: string,
  decidedBy: string,
): { draft: DraftRow; resolvedGaps: number } {
  const row = getDraftOrThrow(db, id);
  if (row.status !== 'pending') {
    throw new AppError('conflict', `szkic nie czeka na recenzję (status: ${humanize(row.status).label})`, {
      status: row.status,
    });
  }
  if (row.namespace === null) {
    throw new AppError('conflict', 'szkic nie ma przypisanej bazy wiedzy — uzupełnij ją przed zatwierdzeniem');
  }
  assertKbActive(db, row.namespace, 'conflict');
  const draft = promoteDraft(db, id, decidedBy);
  const resolvedGaps = resolveByDraft(db, id, decidedBy);
  return { draft, resolvedGaps };
}

export function rejectDraftEntry(db: Db, id: string, decidedBy: string, reason?: string): DraftRow {
  return rejectDraft(db, id, decidedBy, reason); // repo: tylko pending → rejected
}

/** Wycofanie promocji przed buildem; repo ustawia dirty=1 (zmiana stanu docelowego). */
export function withdrawDraftEntry(db: Db, id: string, decidedBy: string): DraftRow {
  return withdrawDraft(db, id, decidedBy); // repo: tylko promoted → withdrawn
}

/** Twarde usunięcie — WYŁĄCZNIE odrzucone szkice (admin, porządki w Inboxie). */
export function deleteRejectedDraft(db: Db, id: string): DraftRow {
  const tx = db.transaction(() => {
    const row = getDraftOrThrow(db, id);
    if (row.status !== 'rejected') {
      throw new AppError('conflict', `usuwać można wyłącznie odrzucone szkice (status: ${humanize(row.status).label})`, {
        status: row.status,
      });
    }
    // FK learning_gaps.draft_id → drafts.id: odpinamy referencje przed DELETE.
    db.prepare('UPDATE learning_gaps SET draft_id = NULL WHERE draft_id = ?').run(id);
    db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
    return row;
  });
  return tx.immediate();
}

export interface BulkEntryResult {
  id: string;
  ok: boolean;
  reason?: string;
}

export interface BulkEntryReport {
  op: BulkOp;
  dryRun: boolean;
  results: BulkEntryResult[];
  /** Liczba faktycznie wykonanych operacji (0 przy dryRun). */
  applied: number;
}

/** Faza 1: repo bulkDryRun + (dla promote) sprawdzenie KB active per id. */
function bulkPreflight(db: Db, op: BulkOp, ids: string[]): BulkEntryResult[] {
  return bulkDryRun(db, op, ids).map((r) => {
    if (!r.ok || op !== 'promote') return r;
    const row = getDraft(db, r.id);
    const kb = row?.namespace != null ? getKb(db, row.namespace) : null;
    if (kb === null || kb.status !== 'active') {
      return {
        id: r.id,
        ok: false,
        reason: `conflict: baza ${row?.namespace ?? '(brak)'} nie jest aktywna`,
      };
    }
    return r;
  });
}

/**
 * Bulk dwufazowy: dryRun=true → wyłącznie raport per id (zero mutacji);
 * apply → wykonuje TYLKO pozycje ok z preflightu, konflikty raportuje per id
 * (jeden zły id nie blokuje reszty).
 */
export function bulkDraftsEntry(
  db: Db,
  input: { op: BulkOp; ids: string[]; dryRun: boolean; decidedBy: string },
): BulkEntryReport {
  const preflight = bulkPreflight(db, input.op, input.ids);
  if (input.dryRun) return { op: input.op, dryRun: true, results: preflight, applied: 0 };

  let applied = 0;
  const results = preflight.map((r): BulkEntryResult => {
    if (!r.ok) return r;
    try {
      if (input.op === 'promote') promoteDraftEntry(db, r.id, input.decidedBy);
      else rejectDraftEntry(db, r.id, input.decidedBy);
      applied += 1;
      return { id: r.id, ok: true };
    } catch (err) {
      if (err instanceof AppError) return { id: r.id, ok: false, reason: `${err.code}: ${err.message}` };
      throw err;
    }
  });
  return { op: input.op, dryRun: false, results, applied };
}
