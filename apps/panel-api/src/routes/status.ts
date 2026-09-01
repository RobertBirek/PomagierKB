import type { FastifyInstance } from 'fastify';
import { createStatusService } from '../services/status.js';

/**
 * Health cockpit:
 * - GET  /status                        — viewer; sondy równoległe, cache 10 s;
 * - POST /status/breakers/:name/reset   — admin; ręczne zamknięcie breakera.
 * Logika w services/status.ts (zero spawnSync, zero wywołań LLM).
 */
export default async function statusRoutes(app: FastifyInstance): Promise<void> {
  const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' };
  const service = createStatusService({ db: app.db, config: app.config });

  app.get(
    '/status',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { response: { 200: successRef } },
    },
    async () => ({ ok: true as const, data: await service.getStatus() }),
  );

  app.post<{ Params: { name: string } }>(
    '/status/breakers/:name/reset',
    {
      config: { rbac: 'admin', audit: 'breaker.reset', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 128 } },
        },
        response: { 200: successRef },
      },
    },
    async (req, reply) => {
      const breakers = service.resetBreakerByName(req.params.name);
      reply.auditContext = { resourceType: 'breaker', resourceId: req.params.name };
      return { ok: true as const, data: { breakers } };
    },
  );
}
