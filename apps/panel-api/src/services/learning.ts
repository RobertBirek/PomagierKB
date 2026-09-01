import type { Db } from '@pomagierkb/shared/db';
import {
  DRAFT_LIMITS,
  createDraft,
  gapStats,
  getGapOrThrow,
  getKb,
  listGaps,
  setGapStatus,
  type GapRow,
  type GapStatus,
} from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import { humanize } from './messages.js';

/**
 * Serwis luk wiedzy — logika tras /api/v1/learning. Przejścia statusów
 * egzekwuje repo shared (learningGaps.setGapStatus, nielegalne → 409);
 * tu widoki camelCase i przepływ "Utwórz szkic" (gap → pending draft w Inboxie
 * + prefill dla strony Dodaj treść). v1 BEZ auto-draftów z sieci
 * (pipeline-frontend §d — human-in-the-loop).
 */

function safeParse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function gapToApi(row: GapRow): Record<string, unknown> {
  return {
    id: row.id,
    question: row.question,
    source: row.source,
    namespace: row.kb_namespace,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    answerPreview: row.answer_preview,
    status: row.status,
    statusLabel: humanize(row.status).label,
    draftId: row.draft_id,
    metadata: safeParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
    processedAt: row.processed_at,
    processedBy: row.processed_by,
  };
}

export interface GapListQuery {
  status?: GapStatus;
  namespace?: string;
  page: number;
  limit: number;
}

export function listGapEntries(
  db: Db,
  query: GapListQuery,
): { items: Record<string, unknown>[]; total: number } {
  const { items, total } = listGaps(db, {
    ...(query.status !== undefined && { status: query.status }),
    ...(query.namespace !== undefined && { kbNamespace: query.namespace }),
    limit: query.limit,
    offset: (query.page - 1) * query.limit,
  });
  return { items: items.map(gapToApi), total };
}

/** Statystyki per status + suma (kafle strony /learning). */
export function gapStatsEntry(db: Db): { stats: Record<GapStatus, number>; total: number } {
  const stats = gapStats(db);
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  return { stats, total };
}

export function ignoreGap(db: Db, id: string, processedBy: string): GapRow {
  return setGapStatus(db, id, 'ignored', { processedBy });
}

export function resolveGap(db: Db, id: string, processedBy: string): GapRow {
  return setGapStatus(db, id, 'resolved', { processedBy });
}

export interface StartDraftResult {
  gap: GapRow;
  draftId: string;
  /** Prefill dla strony "Dodaj treść" (/add) — operator dostarcza treść. */
  prefill: { question: string; suggestedNamespace: string | null };
}

/**
 * "Utwórz szkic" z luki: pending draft (sourceType 'gap', sourceRef=gap.id)
 * + gap→in_draft z draftId (dzięki temu promocja draftu auto-rozwiązuje lukę
 * przez resolveByDraft w services/drafts.promoteDraftEntry).
 */
export function startDraftFromGap(db: Db, id: string, processedBy: string): StartDraftResult {
  const tx = db.transaction((): StartDraftResult => {
    const gap = getGapOrThrow(db, id);
    if (gap.status !== 'open') {
      throw new AppError('conflict', `luka nie jest otwarta (status: ${humanize(gap.status).label})`, {
        status: gap.status,
      });
    }
    // FK drafts.namespace → kb_registry: sugerowany namespace tylko gdy baza istnieje.
    const kb = gap.kb_namespace !== null ? getKb(db, gap.kb_namespace) : null;
    const draft = createDraft(db, {
      title: gap.question.slice(0, DRAFT_LIMITS.titleMax),
      content: gap.question,
      sourceType: 'gap',
      sourceRef: gap.id,
      namespace: kb?.namespace ?? null,
      metadata: {
        gapId: gap.id,
        ...(gap.answer_preview !== null && { answerPreview: gap.answer_preview }),
      },
      submittedByUser: processedBy,
    });
    const updated = setGapStatus(db, id, 'in_draft', { draftId: draft.id, processedBy });
    return {
      gap: updated,
      draftId: draft.id,
      prefill: { question: gap.question, suggestedNamespace: gap.kb_namespace },
    };
  });
  return tx.immediate();
}
