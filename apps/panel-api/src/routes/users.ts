import type { FastifyInstance } from 'fastify';
import {
  createServiceUser,
  getUserById,
  listUsers,
  setUserStatus,
  toUserView,
  type UserStatus,
} from '../services/users.js';

/**
 * /api/v1/users (wszystko admin) — zarządzanie użytkownikami:
 * - GET    /users      → lista (OIDC + serwisowi), nigdy sekretów;
 * - POST   /users      → WYŁĄCZNIE kind:'service' (tożsamości pod klucze MCP;
 *   konta OIDC powstają same przy logowaniu przez Authentika);
 * - PATCH  /users/:id  → enable/disable; disable kaskadowo unieważnia klucze
 *   API użytkownika i usuwa jego sesje (services/users.ts).
 */

/** Wspólny kształt użytkownika w odpowiedziach (camelCase, bez sekretów). */
const userSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sub',
    'email',
    'displayName',
    'kind',
    'role',
    'status',
    'createdAt',
    'updatedAt',
    'lastLoginAt',
  ],
  properties: {
    id: { type: 'string' },
    sub: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    displayName: { type: 'string' },
    kind: { type: 'string', enum: ['oidc', 'service'] },
    role: { type: 'string', enum: ['viewer', 'operator', 'admin'] },
    status: { type: 'string', enum: ['active', 'disabled'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    lastLoginAt: { type: ['string', 'null'] },
  },
} as const;

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /users ────────────────────────────────────────────────────────────
  app.get(
    '/users',
    {
      config: { rbac: 'admin', audit: false, csrf: false },
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
                required: ['users'],
                properties: { users: { type: 'array', items: userSchema } },
              },
            },
          },
        },
      },
    },
    async () => ({ ok: true as const, data: { users: listUsers(app.db).map(toUserView) } }),
  );

  // ── POST /users (tylko konta serwisowe) ───────────────────────────────────
  app.post(
    '/users',
    {
      config: { rbac: 'admin', audit: 'user.create', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'displayName'],
          properties: {
            // Konta OIDC powstają wyłącznie przez logowanie — API tworzy tylko 'service'.
            kind: { type: 'string', const: 'service' },
            displayName: { type: 'string', minLength: 1, maxLength: 120 },
            // Rola informacyjna (uprawnienia MCP wynikają ze scopes klucza) — bez 'admin'.
            role: { type: 'string', enum: ['viewer', 'operator'], default: 'viewer' },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data'],
            properties: {
              ok: { const: true },
              data: {
                type: 'object',
                additionalProperties: false,
                required: ['user'],
                properties: { user: userSchema },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { displayName: string; role: 'viewer' | 'operator' };
      const user = createServiceUser(app.db, { displayName: body.displayName, role: body.role });
      reply.auditContext = {
        resourceType: 'user',
        resourceId: user.id,
        after: toUserView(user),
      };
      return reply.code(201).send({ ok: true as const, data: { user: toUserView(user) } });
    },
  );

  // ── PATCH /users/:id (enable/disable) ─────────────────────────────────────
  app.patch(
    '/users/:id',
    {
      config: { rbac: 'admin', audit: 'user.update', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['status'],
          properties: { status: { type: 'string', enum: ['active', 'disabled'] } },
        },
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
                required: ['user', 'revokedKeys', 'deletedSessions'],
                properties: {
                  user: userSchema,
                  revokedKeys: { type: 'integer' },
                  deletedSessions: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { status } = req.body as { status: UserStatus };
      const before = getUserById(app.db, id); // null → setUserStatus rzuci not_found
      const result = setUserStatus(app.db, id, status);
      reply.auditContext = {
        resourceType: 'user',
        resourceId: id,
        before: before !== null ? toUserView(before) : undefined,
        after: toUserView(result.user),
        metadata: { revokedKeys: result.revokedKeys, deletedSessions: result.deletedSessions },
      };
      return {
        ok: true as const,
        data: {
          user: toUserView(result.user),
          revokedKeys: result.revokedKeys,
          deletedSessions: result.deletedSessions,
        },
      };
    },
  );
}
