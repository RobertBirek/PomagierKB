import type { FastifyInstance } from 'fastify';
import { verifyChain } from '@pomagierkb/shared/audit';
import { listAudit, type AuditListFilter } from '../services/audit.js';

/**
 * Trasy audytu (tylko admin, tylko odczyt — łańcuch jest append-only):
 * - GET /audit        — filtry from/to/action/actor/outcome + kursor po seq;
 * - GET /audit/verify — przeliczenie hashy ostatnich `limit` wpisów (shared verifyChain).
 */
export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' };

  app.get<{ Querystring: AuditListFilter }>(
    '/audit',
    {
      config: { rbac: 'admin', audit: false, csrf: false },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', minLength: 4, maxLength: 40 },
            to: { type: 'string', minLength: 4, maxLength: 40 },
            action: { type: 'string', minLength: 1, maxLength: 200 },
            actor: { type: 'string', minLength: 1, maxLength: 200 },
            outcome: { type: 'string', enum: ['success', 'error'] },
            beforeSeq: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
        response: { 200: successRef },
      },
    },
    async (req) => {
      const { items, total, nextBeforeSeq } = listAudit(app.db, req.query);
      return {
        ok: true as const,
        data: items,
        meta: { total, limit: req.query.limit ?? 50, ...(nextBeforeSeq !== undefined ? { nextBeforeSeq } : {}) },
      };
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    '/audit/verify',
    {
      config: { rbac: 'admin', audit: false, csrf: false },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100000, default: 5000 } },
        },
        response: { 200: successRef },
      },
    },
    async (req) => ({ ok: true as const, data: verifyChain(app.db, req.query.limit ?? 5000) }),
  );
}
