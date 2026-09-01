import type { FastifyInstance } from 'fastify';
import { SETTINGS_KEYS, type SettingsKey } from '@pomagierkb/shared/db';
import { isSecretKey, listSettings, putSetting, testLlm, type LlmTarget } from '../services/settings.js';

/**
 * Trasy ustawień (wszystkie admin):
 * - GET  /settings              — biała lista kluczy, sekrety zamaskowane;
 * - PUT  /settings/:key         — zapis (sekrety sealowane; pusty apiKey = bez zmiany);
 * - POST /settings/test-llm     — test połączenia z celem chat|openie|embeddings.
 * Logika w services/settings.ts.
 */
export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' };

  app.get(
    '/settings',
    {
      config: { rbac: 'admin', audit: false, csrf: false },
      schema: { response: { 200: successRef } },
    },
    async () => ({ ok: true as const, data: listSettings(app.db, app.config) }),
  );

  app.put<{ Params: { key: SettingsKey }; Body: { value: unknown } }>(
    '/settings/:key',
    {
      config: { rbac: 'admin', audit: 'settings.update', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['key'],
          properties: { key: { type: 'string', enum: [...SETTINGS_KEYS] } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['value'],
          properties: { value: {} },
        },
        response: { 200: successRef },
      },
    },
    async (req, reply) => {
      const { key } = req.params;
      const masked = putSetting(app.db, app.config, key, req.body.value, req.user?.id ?? null);
      // Do audytu NIGDY nie trafia wartość sekretu — tylko fakt zmiany klucza.
      reply.auditContext = {
        resourceType: 'setting',
        resourceId: key,
        after: isSecretKey(key) ? { configured: true } : { value: req.body.value },
        metadata: { isSecret: isSecretKey(key) },
      };
      return { ok: true as const, data: { key, ...masked } };
    },
  );

  app.post<{ Body: { target: LlmTarget } }>(
    '/settings/test-llm',
    {
      config: { rbac: 'admin', audit: 'settings.test_llm', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['target'],
          properties: { target: { type: 'string', enum: ['chat', 'openie', 'embeddings'] } },
        },
        response: { 200: successRef },
      },
    },
    async (req, reply) => {
      reply.auditContext = { resourceType: 'setting', resourceId: `llm.${req.body.target}` };
      const result = await testLlm(app.db, app.config, req.body.target);
      return { ok: true as const, data: result };
    },
  );
}
