import type { FastifyInstance } from 'fastify';
import type { GapStatus } from '@pomagierkb/shared/db';
import {
  gapStatsEntry,
  gapToApi,
  ignoreGap,
  listGapEntries,
  reopenGapEntry,
  resolveGap,
  startDraftFromGap,
} from '../services/learning.js';
import { GAP_STATUSES } from '../services/messages.js';
import { latestQualityReport } from '@pomagierkb/shared/db';
import { startAction } from '../services/actions-runner.js';

/**
 * Trasy /api/v1/learning — luki wiedzy (pętla uczenia, pipeline-frontend §d).
 * Tylko deklaracje (schema + config {rbac,audit,csrf}) — logika w
 * services/learning.ts; przejścia statusów w repo shared (learningGaps).
 * Ścieżki BEZ prefiksu /api/v1 (dodaje go rejestracja w routes/index.ts).
 */

const NAMESPACE_PATTERN = '^[A-Z][A-Za-z0-9]{2,29}$';
const GAP_ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$';

const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' } as const;
const errorRef = { $ref: 'https://pomagierkb/schemas/envelope-error.json#' } as const;

const idParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: GAP_ID_PATTERN } },
} as const;

interface IdParams {
  id: string;
}

export default async function learningRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /learning/gaps — lista z filtrami i meta.total ────────────────────
  app.get<{ Querystring: { status?: GapStatus; namespace?: string; sort?: 'created' | 'evidence'; page: number; limit: number } }>(
    '/learning/gaps',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: [...GAP_STATUSES] },
            namespace: { type: 'string', pattern: NAMESPACE_PATTERN },
            sort: { type: 'string', enum: ['created', 'evidence'], default: 'created' },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
        response: { 200: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req) => {
      const { page, limit } = req.query;
      const { items, total } = listGapEntries(app.db, { ...req.query });
      return { ok: true as const, data: { items }, meta: { page, limit, total } };
    },
  );

  // ── GET /learning/stats — kafle open/in_draft/resolved/ignored ────────────
  app.get(
    '/learning/stats',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async () => ({ ok: true as const, data: gapStatsEntry(app.db) }),
  );

  // ── POST /learning/gaps/:id/ignore ────────────────────────────────────────
  app.post<{ Params: IdParams }>(
    '/learning/gaps/:id/ignore',
    {
      config: { rbac: 'operator', audit: 'gap.ignore', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: idParamsSchema, response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req, reply) => {
      const gap = ignoreGap(app.db, req.params.id, req.user!.id);
      reply.auditContext = { resourceType: 'gap', resourceId: gap.id, after: { status: gap.status } };
      return { ok: true as const, data: { gap: gapToApi(gap) } };
    },
  );

  // ── POST /learning/gaps/:id/resolve ───────────────────────────────────────
  app.post<{ Params: IdParams }>(
    '/learning/gaps/:id/resolve',
    {
      config: { rbac: 'operator', audit: 'gap.resolve', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: idParamsSchema, response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req, reply) => {
      const gap = resolveGap(app.db, req.params.id, req.user!.id);
      reply.auditContext = { resourceType: 'gap', resourceId: gap.id, after: { status: gap.status } };
      return { ok: true as const, data: { gap: gapToApi(gap) } };
    },
  );

  // ── GET /learning/quality — ostatni tygodniowy raport jakości odpowiedzi ──
  app.get(
    '/learning/quality',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async () => {
      const report = latestQualityReport(app.db, '__all__');
      return {
        ok: true as const,
        data: {
          report:
            report !== null
              ? {
                  verdict: report.verdict,
                  createdAt: report.created_at,
                  checks: JSON.parse(report.checks_json) as unknown[],
                }
              : null,
        },
      };
    },
  );

  // ── POST /learning/quality-report — 202: akcja quality_answers (agregacja 7 dni) ──
  app.post(
    '/learning/quality-report',
    {
      config: { rbac: 'operator', audit: 'learning.quality_report', csrf: true, rateLimitGroup: 'mutation' },
      schema: { response: { 202: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req, reply) => {
      const action = startAction(
        { db: app.db, dataDir: app.config.dataDir, warn: (msg) => req.log.warn(msg) },
        { type: 'quality_answers', resource: 'learning:quality', params: {}, startedBy: req.user?.id ?? null },
      );
      reply.auditContext = { resourceType: 'learning', resourceId: 'quality', metadata: { actionId: action.id } };
      return reply.status(202).send({ ok: true as const, data: { actionId: action.id } });
    },
  );

  // ── POST /learning/gaps/:id/reopen — ignored|resolved → open (koniec
  //    nieodwracalności ignore; kolizja z otwartą luką → merge evidence) ─────
  app.post<{ Params: IdParams }>(
    '/learning/gaps/:id/reopen',
    {
      config: { rbac: 'operator', audit: 'gap.reopen', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: idParamsSchema, response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req, reply) => {
      const gap = reopenGapEntry(app.db, req.params.id, req.user!.id);
      reply.auditContext = { resourceType: 'gap', resourceId: gap.id, after: { status: gap.status } };
      return { ok: true as const, data: { gap: gapToApi(gap) } };
    },
  );

  // ── POST /learning/gaps/:id/start-draft → in_draft + prefill dla /add ─────
  app.post<{ Params: IdParams }>(
    '/learning/gaps/:id/start-draft',
    {
      config: { rbac: 'operator', audit: 'gap.start_draft', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: idParamsSchema, response: { 201: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req, reply) => {
      const { gap, draftId, prefill } = startDraftFromGap(app.db, req.params.id, req.user!.id);
      reply.auditContext = {
        resourceType: 'gap',
        resourceId: gap.id,
        after: { status: gap.status, draftId },
      };
      return reply
        .status(201)
        .send({ ok: true as const, data: { gap: gapToApi(gap), draftId, prefill } });
    },
  );
}
