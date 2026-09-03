import { z } from 'zod';
import { getDraft, listDraftsByKey, type DraftRow } from '@pomagierkb/shared/db';
import { errorResult, parseInput } from './common.js';
import type { KbTool, ToolCtx } from './types.js';

/**
 * kb_draft_status — los draftów zgłoszonych TYM kluczem (kb_submit_draft był
 * dotąd pętlą write-only). Z draftId: jeden draft (cudzy/nieistniejący → ten
 * sam błąd — bez wyroczni id); bez: ostatnie 20 + liczniki per status.
 * Scope read wystarcza (wyłącznie własne dane klucza).
 */

const inputZod = z.strictObject({
  draftId: z.string().min(1).max(200).optional(),
});

const STATUS_LABELS: Record<DraftRow['status'], string> = {
  pending: 'czeka na recenzję',
  promoted: 'zatwierdzony (trafi do bazy przy najbliższym buildzie)',
  rejected: 'odrzucony',
  withdrawn: 'wycofany',
};

function toDto(row: DraftRow) {
  return {
    draftId: row.id,
    status: row.status,
    title: row.title,
    namespace: row.namespace,
    createdAt: row.created_at,
    ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
    ...(row.reject_reason !== null ? { rejectReason: row.reject_reason } : {}),
    ...(row.promoted_at !== null ? { promotedAt: row.promoted_at } : {}),
  };
}

function describe(row: DraftRow): string {
  const base = `**${row.title}** (${row.id}) — ${STATUS_LABELS[row.status]}`;
  return row.status === 'rejected' && row.reject_reason !== null
    ? `${base}. Powód: ${row.reject_reason}`
    : base;
}

export const kbDraftStatusTool: KbTool = {
  name: 'kb_draft_status',
  title: 'Status zgłoszonych draftów',
  description:
    'Sprawdza los draftów zgłoszonych tym kluczem przez kb_submit_draft: z draftId ' +
    'jeden draft (pending/promoted/rejected z powodem/withdrawn), bez — ostatnie 20 z licznikami.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      draftId: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['drafts'],
    properties: {
      drafts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['draftId', 'status', 'title'],
          properties: {
            draftId: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'promoted', 'rejected', 'withdrawn'] },
            title: { type: 'string' },
            namespace: { type: 'string' },
            createdAt: { type: 'string' },
            decidedAt: { type: 'string' },
            promotedAt: { type: 'string' },
            rejectReason: { type: 'string' },
          },
        },
      },
      counts: {
        type: 'object',
        properties: {
          pending: { type: 'integer' },
          promoted: { type: 'integer' },
          rejected: { type: 'integer' },
          withdrawn: { type: 'integer' },
        },
      },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  async handler(ctx: ToolCtx, input) {
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const { draftId } = parsed.data;

    if (draftId !== undefined) {
      const row = getDraft(ctx.db, draftId);
      if (row === null || row.submitted_by_key !== ctx.keyRow.id) {
        return errorResult('validation', `Draft nie istnieje: ${draftId}`);
      }
      return { structured: { drafts: [toDto(row)] }, text: describe(row) };
    }

    const rows = listDraftsByKey(ctx.db, ctx.keyRow.id, 20);
    const counts = { pending: 0, promoted: 0, rejected: 0, withdrawn: 0 };
    for (const r of rows) counts[r.status]++;
    const text =
      rows.length === 0
        ? 'Ten klucz nie zgłosił jeszcze żadnego draftu.'
        : `**Twoje drafty** (ostatnie ${rows.length}; czeka: ${counts.pending}, zatwierdzone: ${counts.promoted}, odrzucone: ${counts.rejected}):\n\n${rows.map((r) => `- ${describe(r)}`).join('\n')}`;
    return { structured: { drafts: rows.map(toDto), counts }, text };
  },
};
