import type { FastifyInstance } from 'fastify';
import { DRAFT_LIMITS, getDraftOrThrow, type BulkOp, type DraftStatus } from '@pomagierkb/shared/db';
import {
  bulkDraftsEntry,
  deleteRejectedDraft,
  draftToDetail,
  draftToListItem,
  listDraftEntries,
  patchDraftEntry,
  promoteDraftEntry,
  rejectDraftEntry,
  withdrawDraftEntry,
  type DraftApiPatch,
} from '../services/drafts.js';
import { DRAFT_STATUSES } from '../services/messages.js';

/**
 * Trasy /api/v1/drafts — Inbox (recenzja human-in-the-loop). Tylko deklaracje
 * (schema + config {rbac,audit,csrf}) — logika w services/drafts.ts; przejścia
 * statusów i dirty=1 w repo shared. Ścieżki BEZ prefiksu /api/v1 (dodaje go
 * rejestracja w routes/index.ts).
 */

const NAMESPACE_PATTERN = '^[A-Z][A-Za-z0-9]{2,29}$';
const DRAFT_ID_PATTERN = '^[A-Za-z0-9_-]{1,200}$';

const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' } as const;
const errorRef = { $ref: 'https://pomagierkb/schemas/envelope-error.json#' } as const;

const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: DRAFT_ID_PATTERN } },
} as const;

interface IdParams {
  id: string;
}

export default async function draftsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /drafts — lista z filtrami i meta.total ───────────────────────────
  app.get<{ Querystring: { status?: DraftStatus; namespace?: string; q?: string; page: number; limit: number } }>(
    '/drafts',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: [...DRAFT_STATUSES] },
            namespace: { type: 'string', pattern: NAMESPACE_PATTERN },
            q: { type: 'string', minLength: 1, maxLength: 200 },
            tag: { type: 'string', minLength: 1, maxLength: 64 },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
        response: { 200: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req) => {
      const { page, limit } = req.query;
      const { items, total } = listDraftEntries(app.db, { ...req.query });
      return { ok: true as const, data: { items }, meta: { page, limit, total } };
    },
  );

  // ── GET /drafts/:id — pełna treść + analysis + ludzki status ──────────────
  app.get<{ Params: IdParams }>(
    '/drafts/:id',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { params: idParamsSchema, response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req) => ({
      ok: true as const,
      data: { draft: draftToDetail(getDraftOrThrow(app.db, req.params.id)) },
    }),
  );

  // ── PATCH /drafts/:id — tylko pending: title/tags/namespace/documentCategory ──
  app.patch<{ Params: IdParams; Body: DraftApiPatch }>(
    '/drafts/:id',
    {
      config: { rbac: 'operator', audit: 'draft.update', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        params: idParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: DRAFT_LIMITS.titleMax },
            tags: {
              type: 'array',
              maxItems: DRAFT_LIMITS.tagsMax,
              items: { type: 'string', minLength: 1, maxLength: 64 },
            },
            // Zmiana przypisania wymaga AKTYWNEJ bazy (walidacja w serwisie).
            namespace: { type: 'string', pattern: NAMESPACE_PATTERN },
            documentCategory: { type: ['string', 'null'], maxLength: 100 },
          },
        },
        response: { 200: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req, reply) => {
      const { before, after } = patchDraftEntry(app.db, req.params.id, req.body);
      reply.auditContext = {
        resourceType: 'draft',
        resourceId: after.id,
        before: draftToListItem(before),
        after: draftToListItem(after),
      };
      return { ok: true as const, data: { draft: draftToDetail(after) } };
    },
  );

  // ── POST /drafts/:id/promote — 409 gdy nie pending LUB KB nie active ──────
  app.post<{ Params: IdParams }>(
    '/drafts/:id/promote',
    {
      config: { rbac: 'operator', audit: 'draft.promote', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: idParamsSchema, response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req, reply) => {
      const { draft, resolvedGaps } = promoteDraftEntry(app.db, req.params.id, req.user!.id);
      reply.auditContext = {
        resourceType: 'draft',
        resourceId: draft.id,
        after: { status: draft.status, namespace: draft.namespace },
        metadata: { resolvedGaps },
      };
      return { ok: true as const, data: { draft: draftToListItem(draft), resolvedGaps } };
    },
  );

  // ── POST /drafts/:id/reject {reason?} — tylko pending ─────────────────────
  app.post<{ Params: IdParams; Body: { reason?: string } }>(
    '/drafts/:id/reject',
    {
      config: { rbac: 'operator', audit: 'draft.reject', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        params: idParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: 2000 } },
        },
        response: { 200: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req, reply) => {
      const draft = rejectDraftEntry(app.db, req.params.id, req.user!.id, req.body?.reason);
      reply.auditContext = {
        resourceType: 'draft',
        resourceId: draft.id,
        after: { status: draft.status, rejectReason: draft.reject_reason },
      };
      return { ok: true as const, data: { draft: draftToListItem(draft) } };
    },
  );

  // ── POST /drafts/:id/withdraw — tylko promoted (dirty=1 przez repo) ───────
  app.post<{ Params: IdParams }>(
    '/drafts/:id/withdraw',
    {
      config: { rbac: 'operator', audit: 'draft.withdraw', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: idParamsSchema, response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req, reply) => {
      const draft = withdrawDraftEntry(app.db, req.params.id, req.user!.id);
      reply.auditContext = {
        resourceType: 'draft',
        resourceId: draft.id,
        after: { status: draft.status, namespace: draft.namespace },
      };
      return { ok: true as const, data: { draft: draftToListItem(draft) } };
    },
  );

  // ── POST /drafts/bulk — dwufazowo: dryRun (raport per id) → apply tylko ok ──
  app.post<{ Body: { op: BulkOp; ids: string[]; dryRun: boolean } }>(
    '/drafts/bulk',
    {
      config: { rbac: 'operator', audit: 'draft.bulk', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'ids'],
          properties: {
            op: { type: 'string', enum: ['promote', 'reject'] },
            ids: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: { type: 'string', pattern: DRAFT_ID_PATTERN },
            },
            dryRun: { type: 'boolean', default: false },
          },
        },
        response: { 200: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req, reply) => {
      const report = bulkDraftsEntry(app.db, { ...req.body, decidedBy: req.user!.id });
      reply.auditContext = {
        resourceType: 'draft',
        resourceId: 'bulk',
        metadata: {
          op: report.op,
          dryRun: report.dryRun,
          requested: req.body.ids.length,
          applied: report.applied,
          conflicts: report.results.filter((r) => !r.ok).length,
        },
      };
      return { ok: true as const, data: report };
    },
  );

  // ── DELETE /drafts/:id — admin, WYŁĄCZNIE rejected (porządki) ─────────────
  app.delete<{ Params: IdParams }>(
    '/drafts/:id',
    {
      config: { rbac: 'admin', audit: 'draft.delete', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: idParamsSchema, response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req, reply) => {
      const deleted = deleteRejectedDraft(app.db, req.params.id);
      reply.auditContext = {
        resourceType: 'draft',
        resourceId: deleted.id,
        before: draftToListItem(deleted),
      };
      return { ok: true as const, data: { deleted: deleted.id } };
    },
  );
}
