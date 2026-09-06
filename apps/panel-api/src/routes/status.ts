import type { FastifyInstance } from 'fastify';
import { currentMigrationId } from '@pomagierkb/shared/db';
import { createStatusService } from '../services/status.js';

/**
 * Health cockpit:
 * - GET  /status                        — viewer; sondy równoległe, cache 10 s;
 * - POST /status/breakers/:name/reset   — admin; ręczne zamknięcie breakera.
 * Logika w services/status.ts (zero spawnSync, zero wywołań LLM).
 *
 * TOŻSAMOŚĆ WYDANIA (blok `release`): bez niej nie da się zdalnie ustalić,
 * z jakiego commitu działa produkcja i czy migracje bazy dogoniły obraz.
 * gitSha/builtAt wstrzykują obrazy (services/{panel,mcp}/Dockerfile: ENV
 * APP_GIT_SHA/APP_BUILT_AT z build.args w deploy/kag/compose.yaml), a
 * migrationVersion czytamy z SQLite (MAX(schema_migrations.id)). Poza obrazem
 * (dev, testy) zmienne nie istnieją → null, nigdy zgadywanie.
 */

/** Wersja obrazu i schematu bazy — czytane przy KAŻDYM żądaniu (bez cache'u sond). */
function releaseInfo(app: FastifyInstance): {
  gitSha: string | null;
  builtAt: string | null;
  migrationVersion: number;
} {
  const env = (key: string): string | null => {
    const raw = process.env[key];
    return raw !== undefined && raw.trim() !== '' ? raw.trim() : null;
  };
  return {
    gitSha: env('APP_GIT_SHA'),
    builtAt: env('APP_BUILT_AT'),
    migrationVersion: currentMigrationId(app.db),
  };
}

export default async function statusRoutes(app: FastifyInstance): Promise<void> {
  const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' };
  const service = createStatusService({ db: app.db, config: app.config });

  app.get(
    '/status',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { response: { 200: successRef } },
    },
    async () => ({
      ok: true as const,
      data: { ...(await service.getStatus()), release: releaseInfo(app) },
    }),
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
