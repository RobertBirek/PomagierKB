import type { FastifyInstance } from 'fastify';

/**
 * GET /healthz — publiczny healthcheck Dockera: proces żyje, ZERO dotykania
 * upstreamów (OpenSPG/LLM/Stirling sprawdza dopiero /api/v1/status).
 */
export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/healthz',
    {
      config: { rbac: false, audit: false, csrf: false },
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data'],
            properties: {
              ok: { const: true },
              data: {
                type: 'object',
                additionalProperties: false,
                required: ['status'],
                properties: { status: { type: 'string', enum: ['ok'] } },
              },
            },
          },
        },
      },
    },
    async () => ({ ok: true as const, data: { status: 'ok' as const } }),
  );
}
