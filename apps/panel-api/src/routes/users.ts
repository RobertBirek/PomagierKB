import type { FastifyInstance } from 'fastify';
import { invalidateMcpCache } from '../services/mcp-admin.js';
import {
  anonymizeUser,
  createServiceUser,
  getUserById,
  listUsers,
  setUserStatus,
  toUserView,
  type UserRow,
  type UserStatus,
} from '../services/users.js';

/**
 * /api/v1/users (wszystko admin) — zarządzanie użytkownikami:
 * - GET    /users      → lista (OIDC + serwisowi), nigdy sekretów;
 * - POST   /users      → WYŁĄCZNIE kind:'service' (tożsamości pod klucze MCP;
 *   konta OIDC powstają same przy logowaniu przez Authentika);
 * - PATCH  /users/:id  → enable/disable; disable kaskadowo unieważnia klucze
 *   API użytkownika i usuwa jego sesje (services/users.ts);
 * - POST   /users/:id/anonymize → nieodwracalne wyczyszczenie danych osobowych
 *   wyłączonego konta (offboarding / art. 17 RODO).
 * Mutacje odbierające dostęp (disable, anonymize) domykają okno cache'u
 * mcp-servera przez best-effort invalidateMcpCache (audyt D9-02).
 */

/**
 * Rzut użytkownika do AUDYTU — bez e-maila, nazwy i `sub` (audyt D14-05).
 * Łańcuch audytu jest niezmienialny i bezterminowy, więc anonimizacja konta
 * nigdy go nie obejmie; nie może zatem zawierać danych identyfikujących wprost.
 */
function toUserAuditView(row: UserRow): Record<string, unknown> {
  return { id: row.id, kind: row.kind, role: row.role, status: row.status };
}

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
        after: toUserAuditView(user),
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
      const result = setUserStatus(app.db, id, status, {
        ...(req.user !== null ? { actorId: req.user.id } : {}),
      });
      reply.auditContext = {
        resourceType: 'user',
        resourceId: id,
        before: before !== null ? toUserAuditView(before) : undefined,
        after: toUserAuditView(result.user),
        metadata: { revokedKeys: result.revokedKeys, deletedSessions: result.deletedSessions },
      };
      // Kaskadowe revoke kluczy MCP obowiązywałoby dopiero po wygaśnięciu cache
      // mcp-servera (60 s) — domykamy okno tak jak rotate/revoke klucza.
      if (status === 'disabled' && result.revokedKeys > 0) {
        await invalidateMcpCache(app.config, { logger: req.log });
      }
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

  // ── POST /users/:id/anonymize (nieodwracalne czyszczenie danych osobowych) ─
  app.post(
    '/users/:id/anonymize',
    {
      config: { rbac: 'admin', audit: 'user.anonymize', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
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
                required: ['user', 'revokedKeys', 'deletedSessions', 'detachedAnswers'],
                properties: {
                  user: userSchema,
                  revokedKeys: { type: 'integer' },
                  deletedSessions: { type: 'integer' },
                  detachedAnswers: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const before = getUserById(app.db, id); // null → anonymizeUser rzuci not_found
      const result = anonymizeUser(app.db, id);
      reply.auditContext = {
        resourceType: 'user',
        resourceId: id,
        before: before !== null ? toUserAuditView(before) : undefined,
        after: toUserAuditView(result.user),
        metadata: {
          revokedKeys: result.revokedKeys,
          deletedSessions: result.deletedSessions,
          detachedAnswers: result.detachedAnswers,
        },
      };
      if (result.revokedKeys > 0) {
        await invalidateMcpCache(app.config, { logger: req.log });
      }
      return {
        ok: true as const,
        data: {
          user: toUserView(result.user),
          revokedKeys: result.revokedKeys,
          deletedSessions: result.deletedSessions,
          detachedAnswers: result.detachedAnswers,
        },
      };
    },
  );
}
