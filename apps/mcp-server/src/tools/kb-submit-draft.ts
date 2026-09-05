import { createHash } from 'node:crypto';
import { z } from 'zod';
import { appendAudit } from '@pomagierkb/shared/audit';
import { createDraft, findByContentHash } from '@pomagierkb/shared/db';
import { appErrorToResult, errorResult, parseInput } from './common.js';
import type { KbTool } from './types.js';

/**
 * kb_submit_draft — JEDYNA droga zapisu przez MCP i NIGDY do grafu: draft trafia
 * do Inboxu (status pending) i czeka na recenzję CZŁOWIEKA. Wymaga scope 'write'
 * (deny-by-default). Dedup po content_hash: istniejący pending → zwracamy jego id.
 */

const inputZod = z.strictObject({
  namespace: z.string(),
  title: z.string().min(3).max(300),
  content: z.string().min(50).max(100_000),
  sourceUrl: z
    .string()
    .refine((s) => URL.canParse(s), { message: 'sourceUrl musi być poprawnym URI' })
    .optional(),
  tags: z.array(z.string()).max(10).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const kbSubmitDraftTool: KbTool = {
  name: 'kb_submit_draft',
  title: 'Zgłoś treść do bazy wiedzy',
  description:
    'Zgłasza treść (markdown) jako draft do Inboxu wskazanej bazy wiedzy. ' +
    'Draft NIE trafia do grafu — wymaga recenzji i promocji przez człowieka. Wymaga scope write.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['namespace', 'title', 'content'],
    properties: {
      namespace: { type: 'string' },
      title: { type: 'string', minLength: 3, maxLength: 300 },
      content: { type: 'string', minLength: 50, maxLength: 100000, description: 'Markdown' },
      sourceUrl: { type: 'string', format: 'uri' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      idempotencyKey: {
        type: 'string',
        minLength: 8,
        maxLength: 128,
        description: 'Klucz idempotencji per klucz API — retry zwraca ten sam draftId zamiast duplikatu',
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['draftId', 'status', 'reviewRequired'],
    properties: {
      draftId: { type: 'string' },
      status: { type: 'string' },
      reviewRequired: { type: 'boolean' },
      duplicate: { type: 'boolean', description: 'true = identyczna treść już czekała w Inboxie' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  /** §7.2: deny-by-default — jedyna droga zapisu przez MCP wymaga scope write. */
  requiresWriteScope: true,

  async handler(ctx, input) {
    if (!ctx.scopes.includes('write')) {
      return errorResult('forbidden', 'Ten klucz nie ma uprawnienia write — kb_submit_draft wymaga scope write.');
    }
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const { namespace, title, content, sourceUrl, tags, idempotencyKey } = parsed.data;
    if (!ctx.allowedNamespaces.includes(namespace)) {
      return errorResult(
        'namespace_not_allowed',
        `Namespace poza profilem klucza: ${namespace}. Dostępne: ${ctx.allowedNamespaces.join(', ') || '(brak)'}.`,
      );
    }

    // Idempotencja jawna (stateless retry może trafić inną instancję): (klucz API,
    // idempotencyKey) → istniejący draft NIEZALEŻNIE od treści (indeks z migracji 0006).
    if (idempotencyKey !== undefined) {
      const prior = ctx.db
        .prepare(
          "SELECT id, status FROM drafts WHERE submitted_by_key = ? AND json_extract(metadata_json, '$.idempotencyKey') = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(ctx.keyRow.id, idempotencyKey) as { id: string; status: string } | undefined;
      if (prior !== undefined) {
        return {
          structured: { draftId: prior.id, status: 'inbox', reviewRequired: true, duplicate: true },
          text: `To zgłoszenie już istnieje (idempotencyKey) — zwracam draft \`${prior.id}\` (status: ${prior.status}). Nie utworzono duplikatu.`,
        };
      }
    }

    // Idempotencja treściowa: identyczna treść w tym namespace z pending draftem → istniejący id.
    const hash = createHash('sha256').update(content, 'utf8').digest('hex');
    const existing = findByContentHash(ctx.db, namespace, hash);
    if (existing !== null && existing.status === 'pending') {
      return {
        structured: { draftId: existing.id, status: 'inbox', reviewRequired: true, duplicate: true },
        text:
          `Identyczna treść już czeka na recenzję w Inboxie — zwracam istniejący draft \`${existing.id}\`. ` +
          'Nie utworzono duplikatu.',
      };
    }

    try {
      const draft = createDraft(ctx.db, {
        title,
        content,
        sourceType: 'mcp',
        namespace,
        sourceRef: sourceUrl ?? null,
        tags: tags ?? [],
        ...(idempotencyKey !== undefined ? { metadata: { idempotencyKey } } : {}),
        submittedByKey: ctx.keyRow.id,
      });
      appendAudit(ctx.db, {
        actor: ctx.keyRow.id,
        actorType: 'api_key',
        action: 'mcp.submit_draft',
        resourceType: 'draft',
        resourceId: draft.id,
        metadata: { namespace, title, contentLength: content.length },
      });
      return {
        structured: { draftId: draft.id, status: 'inbox', reviewRequired: true },
        text:
          `Utworzono draft \`${draft.id}\` w Inboxie bazy **${namespace}**. ` +
          'Treść trafi do bazy wiedzy dopiero po recenzji i promocji przez człowieka.',
      };
    } catch (err) {
      const mapped = appErrorToResult(err);
      if (mapped) return mapped;
      throw err;
    }
  },
};
