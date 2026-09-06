import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import cookie from '@fastify/cookie';
import type { Db } from '@pomagierkb/shared/db';
import { successEnvelopeSchema, errorEnvelopeSchema } from '@pomagierkb/shared/schemas';
import type { AppConfig } from './config.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerSession } from './plugins/session.js';
import { registerRbac } from './plugins/rbac.js';
import { registerCsrf } from './plugins/csrf.js';
import { registerAudit } from './plugins/audit.js';
import { registerSwagger } from './plugins/swagger.js';
import { registerSse } from './plugins/sse.js';
import { resolveTrustProxy } from './plugins/trust-proxy.js';
import registerRoutes from './routes/index.js';
import './types.js'; // augmentacje Fastify (db/config/user/sse/route.config)

/** Zależności buildApp — wszystko wstrzykiwalne (testy: makeTestConfig + :memory:). */
export interface AppDeps {
  config: AppConfig;
  db: Db;
  /** Własny logger (np. false w testach); domyślnie pino z redakcją sekretów. */
  logger?: FastifyBaseLogger | boolean;
}

/** Ścieżki redagowane w logach (pino redact) — sekrety nigdy w logu. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.apiKey',
  '*.password',
  '*.secret',
  '*.token',
];

/** Trasy, których logi żądań są wyciszone do 'warn' (healthcheck Dockera co 30 s). */
const QUIET_ROUTES = new Set(['/healthz']);

/**
 * Serializer żądań do logu: jak domyślny fastify, ale url BEZ query stringu.
 * Powód (audyt D4-08): `GET /auth/callback?code=...&state=...` utrwalał
 * jednorazowy kod autoryzacyjny OIDC w json-file Dockera. Sama ścieżka
 * wystarcza do diagnostyki tras, a znika cała klasa „sekret w query".
 */
export function serializeRequest(req: FastifyRequest): Record<string, unknown> {
  const url = String(req.url ?? '');
  const queryAt = url.indexOf('?');
  return {
    method: req.method,
    url: queryAt === -1 ? url : url.slice(0, queryAt),
    host: req.host,
    // Po naprawie trustProxy (D2-01) to realny adres klienta z X-Forwarded-For.
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * Buduje aplikację Fastify BEZ nasłuchu (testy przez app.inject()).
 * Kolejność rejestracji (wiążąca): error-handler → dekoratory db/config
 * → rate-limit → cookie → session → rbac → csrf → audit → swagger → sse
 * → trasy (routes/index.ts).
 * Fazy cyklu żądania (patrz komentarze w plugins/*): onRequest = rate-limit,
 * sesja, CSRF → preValidation = RBAC (401 PRZED walidacją schematu, audyt D3-01)
 * → walidacja → handler → onResponse = audyt.
 * Statyki frontu NIE są tu rejestrowane — server.ts woła registerStatics()
 * osobno (testy API nie chcą fallbacku SPA).
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps;

  const ajv = {
    customOptions: {
      // additionalProperties:false ma ODRZUCAĆ nadmiarowe pola (400), nie wycinać.
      removeAdditional: false,
      coerceTypes: 'array' as const,
      useDefaults: true,
    },
  };

  // Jedyny hop przed nami to Caddy (port niepublikowany). Wariant ADRESOWY —
  // wariant liczbowy (dawne `trustProxy: 1`) jest w fastify 5 fail-closed i
  // cicho ignoruje X-Forwarded-For (audyt D2-01); szczegóły w plugins/trust-proxy.ts.
  const trustProxy = resolveTrustProxy();
  const app: FastifyInstance =
    deps.logger !== undefined && typeof deps.logger === 'object'
      ? Fastify({ trustProxy, ajv, loggerInstance: deps.logger })
      : Fastify({
          trustProxy,
          ajv,
          logger:
            (deps.logger ?? config.nodeEnv !== 'test')
              ? {
                  level: process.env['LOG_LEVEL'] ?? 'info',
                  redact: REDACT_PATHS,
                  serializers: { req: serializeRequest },
                }
              : false,
        });

  // Healthcheck Dockera co 30 s dawał 2 linie INFO na serwis (~75% logu panelu —
  // audyt D10-06). Wyciszamy TYLKO logi żądań tych tras (błędy nadal na 'warn'+).
  app.addHook('onRoute', (route) => {
    if (QUIET_ROUTES.has(route.url)) route.logLevel = 'warn';
  });

  // 1) Obsługa błędów + mapa 404/405 (musi widzieć wszystkie późniejsze trasy).
  registerErrorHandler(app);

  // 2) Dekoratory współdzielone.
  app.decorate('db', db);
  app.decorate('config', config);

  // Wspólne schematy z $id — trasy mogą używać { $ref: '...envelope-*.json#' }.
  app.addSchema(successEnvelopeSchema);
  app.addSchema(errorEnvelopeSchema);

  // 3) Rate limit (onRoute tłumaczący rateLimitGroup + plugin globalny).
  await registerRateLimit(app);

  // 4) Cookies (parser + podpis; sesja korzysta z kag_sid).
  await app.register(cookie, { secret: config.sessionSecret });

  // 5) Sesja: cookie kag_sid → SQLite (TTL 12 h / idle 60 min, leniwy refresh OIDC);
  //    dekoruje też app.oidc (leniwe discovery Authentika).
  registerSession(app);

  // 6) RBAC deny-by-default wg route.config.rbac.
  registerRbac(app);

  // 7) CSRF: weryfikacja Origin/Sec-Fetch-Site na mutacjach z config.csrf=true.
  registerCsrf(app);

  // 8) Audyt mutacji wg route.config.audit (hash-chain przez shared/audit).
  registerAudit(app);

  // 9) OpenAPI (GET /openapi.json, tylko admin).
  await registerSwagger(app);

  // 10) Helper SSE (reply.sse()).
  registerSse(app);

  // 11) Trasy — centralny rejestr modułów.
  await app.register(registerRoutes);

  return app;
}
