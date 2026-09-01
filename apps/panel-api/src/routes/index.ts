import type { FastifyInstance } from 'fastify';
import healthRoutes from './health.js';
import kbsRoutes from './kbs.js';
import authRoutes from './auth.js';
import meRoutes from './me.js';
import usersRoutes from './users.js';
import actionsRoutes from './actions.js';
import statusRoutes from './status.js';
import auditRoutes from './audit.js';
import mcpAdminRoutes from './mcp-admin.js';
import settingsRoutes from './settings.js';

/**
 * CENTRALNY REJESTR MODUŁÓW TRAS. Agenci modułów DOPISUJĄ tutaj swoje importy
 * i rejestracje — nigdzie indziej. Konwencja:
 * - jeden moduł = jeden plik routes/<nazwa>.ts z `export default async function (app)`;
 * - trasy /api/v1/* rejestrowane z { prefix: '/api/v1' } (w module ścieżki BEZ prefiksu);
 * - /auth/* i /healthz bez prefiksu;
 * - każda trasa: schema (additionalProperties:false) + config { rbac, audit, csrf }
 *   (+ opcjonalnie rateLimitGroup) — logika w services/, tu tylko deklaracje.
 */
export default async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
  await app.register(authRoutes); // /auth/* — bez prefiksu (OIDC login/callback/logout)
  await app.register(meRoutes, { prefix: '/api/v1' });
  await app.register(usersRoutes, { prefix: '/api/v1' });

  // ── PLACEHOLDERY — agenci dopisują poniżej (kolejność bez znaczenia) ──────
  await app.register(statusRoutes, { prefix: '/api/v1' }); // routes/status.ts
  await app.register(kbsRoutes, { prefix: '/api/v1' }); // routes/kbs.ts
  // drafts:    await app.register(draftsRoutes, { prefix: '/api/v1' });    // routes/drafts.ts
  await app.register(actionsRoutes, { prefix: '/api/v1' }); // routes/actions.ts (SSE)
  await app.register(auditRoutes, { prefix: '/api/v1' }); // routes/audit.ts
  // learning:  await app.register(learningRoutes, { prefix: '/api/v1' });  // routes/learning.ts
  await app.register(mcpAdminRoutes, { prefix: '/api/v1' }); // routes/mcp-admin.ts (profiles/keys/snippets)
  await app.register(settingsRoutes, { prefix: '/api/v1' }); // routes/settings.ts
}
