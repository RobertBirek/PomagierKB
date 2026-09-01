import type { FastifyInstance } from 'fastify';
import {
  KNOWN_MCP_TOOLS,
  createProfile,
  deleteProfile,
  listProfiles,
  updateProfile,
  type McpProfilePatch,
} from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import {
  buildSnippets,
  checkMcpHealth,
  createKeyForUser,
  invalidateMcpCache,
  listKeys,
  revokeKeyAs,
  rotateKeyAs,
  toKeyView,
  toProfileView,
  type CreateKeyInput,
} from '../services/mcp-admin.js';

/**
 * Trasy administracji MCP: profile (mutacje: admin), klucze API (operator/admin,
 * właściciel dla rotate/revoke), snippety konfiguracyjne i health mcp-servera.
 * Logika w services/mcp-admin.ts + repo shared (mcpProfiles/apiKeys).
 */
export default async function mcpAdminRoutes(app: FastifyInstance): Promise<void> {
  const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' };

  const idParam = {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
  } as const;

  // ── Profile ───────────────────────────────────────────────────────────────

  app.get(
    '/mcp/profiles',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { response: { 200: successRef } },
    },
    async () => ({ ok: true as const, data: listProfiles(app.db).map(toProfileView) }),
  );

  const profileBodyProps = {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    namespaces: {
      type: ['array', 'null'],
      items: { type: 'string', minLength: 1, maxLength: 128 },
      maxItems: 50,
    },
    tools: {
      type: 'array',
      items: { type: 'string', enum: [...KNOWN_MCP_TOOLS] },
      minItems: 1,
      maxItems: KNOWN_MCP_TOOLS.length,
    },
    enabled: { type: 'boolean' },
  } as const;

  interface ProfileBody {
    id: string;
    name: string;
    description?: string | null;
    namespaces?: string[] | null;
    tools: string[];
    enabled?: boolean;
  }

  app.post<{ Body: ProfileBody }>(
    '/mcp/profiles',
    {
      config: { rbac: 'admin', audit: 'mcp.profile.create', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'name', 'tools'],
          properties: profileBodyProps,
        },
        response: { 201: successRef },
      },
    },
    async (req, reply) => {
      const row = createProfile(app.db, req.body);
      const view = toProfileView(row);
      reply.auditContext = { resourceType: 'mcp_profile', resourceId: row.id, after: view };
      reply.code(201);
      return { ok: true as const, data: view };
    },
  );

  app.patch<{ Params: { id: string }; Body: McpProfilePatch }>(
    '/mcp/profiles/:id',
    {
      config: { rbac: 'admin', audit: 'mcp.profile.update', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: profileBodyProps.name,
            description: profileBodyProps.description,
            namespaces: profileBodyProps.namespaces,
            tools: profileBodyProps.tools,
            enabled: profileBodyProps.enabled,
          },
        },
        response: { 200: successRef },
      },
    },
    async (req, reply) => {
      const row = updateProfile(app.db, req.params.id, req.body);
      const view = toProfileView(row);
      reply.auditContext = { resourceType: 'mcp_profile', resourceId: row.id, after: view };
      return { ok: true as const, data: view };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/mcp/profiles/:id',
    {
      config: { rbac: 'admin', audit: 'mcp.profile.delete', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: idParam, response: { 200: successRef } },
    },
    async (req, reply) => {
      deleteProfile(app.db, req.params.id); // 409 przy aktywnych kluczach (repo)
      reply.auditContext = { resourceType: 'mcp_profile', resourceId: req.params.id };
      return { ok: true as const, data: { deleted: true } };
    },
  );

  // ── Klucze ────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { userId?: string } }>(
    '/mcp/keys',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { userId: { type: 'string', minLength: 1, maxLength: 128 } },
        },
        response: { 200: successRef },
      },
    },
    async (req) => {
      const user = req.user;
      if (user === null) throw new AppError('unauthorized', 'Wymagane zalogowanie');
      // ?userId= dostępne tylko dla admina (dla pozostałych zawsze własne klucze).
      if (req.query.userId !== undefined && user.role !== 'admin') {
        throw new AppError('forbidden', 'Filtr userId dostępny tylko dla admina');
      }
      return { ok: true as const, data: listKeys(app.db, user, req.query.userId) };
    },
  );

  app.post<{ Body: CreateKeyInput }>(
    '/mcp/keys',
    {
      config: { rbac: 'operator', audit: 'mcp.key.create', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'profileId'],
          properties: {
            label: { type: 'string', minLength: 1, maxLength: 200 },
            profileId: { type: 'string', minLength: 1, maxLength: 128 },
            userId: { type: 'string', minLength: 1, maxLength: 128 },
            scopes: {
              type: 'array',
              items: { type: 'string', enum: ['read', 'write'] },
              minItems: 1,
              maxItems: 2,
            },
            ttlDays: { type: 'integer', minimum: 1, maximum: 365, default: 90 },
          },
        },
        response: { 201: successRef },
      },
    },
    async (req, reply) => {
      const user = req.user;
      if (user === null) throw new AppError('unauthorized', 'Wymagane zalogowanie');
      const { row, raw } = createKeyForUser(app.db, user, req.body);
      const view = toKeyView(row);
      // Raw NIGDY do audytu — hash-chain dostaje tylko metadane klucza.
      reply.auditContext = { resourceType: 'api_key', resourceId: row.id, after: view };
      reply.code(201);
      // raw pokazywany DOKŁADNIE RAZ — nie da się go odzyskać później.
      return { ok: true as const, data: { key: view, raw } };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/mcp/keys/:id/rotate',
    {
      config: { rbac: 'viewer', audit: 'mcp.key.rotate', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: idParam, response: { 200: successRef } },
    },
    async (req, reply) => {
      const user = req.user;
      if (user === null) throw new AppError('unauthorized', 'Wymagane zalogowanie');
      const { row, raw } = rotateKeyAs(app.db, user, req.params.id);
      const view = toKeyView(row);
      reply.auditContext = {
        resourceType: 'api_key',
        resourceId: req.params.id,
        after: view,
        metadata: { newKeyId: row.id },
      };
      // Best-effort: cache mcp-servera nie może honorować starego hasha do 60 s.
      await invalidateMcpCache(app.config, { logger: req.log });
      return { ok: true as const, data: { key: view, raw } };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/mcp/keys/:id/revoke',
    {
      config: { rbac: 'viewer', audit: 'mcp.key.revoke', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: idParam, response: { 200: successRef } },
    },
    async (req, reply) => {
      const user = req.user;
      if (user === null) throw new AppError('unauthorized', 'Wymagane zalogowanie');
      const row = revokeKeyAs(app.db, user, req.params.id);
      const view = toKeyView(row);
      reply.auditContext = { resourceType: 'api_key', resourceId: row.id, after: view };
      await invalidateMcpCache(app.config, { logger: req.log });
      return { ok: true as const, data: { key: view } };
    },
  );

  // ── Snippety i health ─────────────────────────────────────────────────────

  app.get<{ Querystring: { profileId: string } }>(
    '/mcp/snippets',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['profileId'],
          properties: { profileId: { type: 'string', minLength: 1, maxLength: 128 } },
        },
        response: { 200: successRef },
      },
    },
    async (req) => ({ ok: true as const, data: buildSnippets(app.db, app.config, req.query.profileId) }),
  );

  app.get(
    '/mcp/health',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { response: { 200: successRef } },
    },
    async () => ({ ok: true as const, data: await checkMcpHealth(app.config) }),
  );
}
