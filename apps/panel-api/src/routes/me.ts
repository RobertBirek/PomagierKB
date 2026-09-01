import type { FastifyInstance } from 'fastify';
import { AppError } from '@pomagierkb/shared/errors';
import { getSessionWithUser } from '../services/sessions.js';

/**
 * GET /api/v1/me (viewer) — tożsamość zalogowanego użytkownika + moment
 * wygaśnięcia sesji (wcześniejszy z TTL absolutnego i idle) dla frontu.
 */
export default async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/me',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
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
                required: ['user', 'session'],
                properties: {
                  user: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'email', 'displayName', 'role'],
                    properties: {
                      id: { type: 'string' },
                      email: { type: ['string', 'null'] },
                      displayName: { type: 'string' },
                      role: { type: 'string', enum: ['viewer', 'operator', 'admin'] },
                    },
                  },
                  session: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['expiresAt'],
                    properties: { expiresAt: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      if (req.user === null) throw new AppError('unauthorized', 'Wymagane zalogowanie'); // rbac to gwarantuje
      const sess = getSessionWithUser(app.db, req.user.sessionHash);
      if (sess === null) throw new AppError('unauthorized', 'Sesja wygasła');
      // Sesja kończy się na wcześniejszym z dwóch TTL (absolutny 12 h / idle 60 min).
      const expiresAt =
        sess.absoluteExpiresAt < sess.idleExpiresAt ? sess.absoluteExpiresAt : sess.idleExpiresAt;
      return {
        ok: true as const,
        data: {
          user: {
            id: req.user.id,
            email: req.user.email,
            displayName: req.user.displayName,
            role: req.user.role,
          },
          session: { expiresAt },
        },
      };
    },
  );
}
