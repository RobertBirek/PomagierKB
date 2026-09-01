import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { checkMigrations, currentMigrationId, openDb, type Db } from '@pomagierkb/shared/db';
import { OpenSpgClient, probeSearch, type SearchProbeResult } from '@pomagierkb/shared/openspg';
import { timingSafeEqualStr } from '@pomagierkb/shared/crypto';
import {
  buildToolLlm,
  loadConfig,
  sharedMigrationsDir,
  type McpConfig,
} from './config.js';
import { AuthService, auditAuthFailure, extractBearer } from './auth.js';
import { ProfileCache } from './profiles.js';
import { RateLimiter } from './rate-limit.js';
import { UsageLog } from './usage-log.js';
import {
  JSONRPC_FORBIDDEN,
  JSONRPC_RATE_LIMITED,
  JSONRPC_UNAUTHORIZED,
  createMcpPair,
} from './mcp.js';
import { allTools } from './tools/index.js';
import type { KbTool, ToolCtx, ToolLlm } from './tools/types.js';

/**
 * Shell HTTP mcp-servera (§7.1): POST /mcp/:profileId → auth → profil → fabryka
 * McpServer+transport per żądanie → transport.handleRequest. GET|DELETE → 405.
 * /healthz, /readyz; wewnętrzny serwer :INTERNAL_PORT z POST /invalidate.
 */

const RATE_LIMIT_PER_MIN = 60;
const RATE_LIMIT_KB_ANSWER_PER_MIN = 10;
const LLM_CACHE_TTL_MS = 60_000;
const PROBE_INTERVAL_MS = 600_000;

interface ProbeStatus extends SearchProbeResult {
  at: string;
  namespace: string;
}

function rpcError(code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export interface BuildServerOptions {
  db: Db;
  config: McpConfig;
  /** Wstrzykiwana lista narzędzi (testy shellowe bez implementacji kb_*). */
  tools?: KbTool[];
  /** Override klienta OpenSPG (null = jawnie wyłączony); default z config.openspg. */
  openspg?: OpenSpgClient | null;
  /** Override budowy LLM (testy); default buildToolLlm z DB settings. */
  llmProvider?: (db: Db, config: McpConfig) => ToolLlm | null;
  /** Katalog migracji do checku w /readyz; default z dist packages/shared. */
  migrationsDir?: string;
  now?: () => number;
  /** Konfiguracja loggera Fastify (default false — cicho w testach). */
  logger?: boolean | Record<string, unknown>;
}

export interface McpServerBundle {
  app: FastifyInstance;
  internal: FastifyInstance;
  auth: AuthService;
  profiles: ProfileCache;
  rateLimiter: RateLimiter;
  usage: UsageLog;
  getLastProbe(): ProbeStatus | null;
  runProbe(): Promise<void>;
  invalidateCaches(): void;
  close(): Promise<void>;
}

export function buildServer(opts: BuildServerOptions): McpServerBundle {
  const { db, config } = opts;
  const now = opts.now ?? Date.now;
  const tools = opts.tools ?? allTools;
  const migrationsDir = opts.migrationsDir ?? sharedMigrationsDir();
  const openspg =
    opts.openspg !== undefined
      ? opts.openspg
      : config.openspg !== null
        ? new OpenSpgClient({
            baseUrl: config.openspg.baseUrl,
            account: config.openspg.account,
            password: config.openspg.password,
          })
        : null;

  const auth = new AuthService({ db, now });
  const profiles = new ProfileCache(db, 60_000, now);
  const rateLimiter = new RateLimiter(now);
  const usage = new UsageLog(config.usageDir);

  // LLM z DB settings — cache 60 s (unseal + konstrukcja klienta nie per żądanie)
  const llmProvider = opts.llmProvider ?? ((d: Db, c: McpConfig) => buildToolLlm(d, c));
  let llmCache: { value: ToolLlm | null; expiresAt: number } | null = null;
  function getLlm(): ToolLlm | null {
    if (llmCache !== null && llmCache.expiresAt > now()) return llmCache.value;
    let value: ToolLlm | null = null;
    try {
      value = llmProvider(db, config);
    } catch {
      value = null;
    }
    llmCache = { value, expiresAt: now() + LLM_CACHE_TTL_MS };
    return value;
  }

  function invalidateCaches(): void {
    auth.invalidate();
    profiles.invalidate();
    llmCache = null;
  }

  // ── Sonda search OpenSPG (start + co 10 min; wynik w /readyz) ─────────────
  let lastProbe: ProbeStatus | null = null;
  async function runProbe(): Promise<void> {
    if (openspg === null) return;
    const row = db
      .prepare(
        "SELECT namespace FROM kb_registry WHERE status = 'active' ORDER BY is_default DESC, namespace LIMIT 1",
      )
      .get() as { namespace: string } | undefined;
    if (row === undefined) return; // brak aktywnych KB — sonda nie ma czego sprawdzić
    const result = await probeSearch(openspg, row.namespace);
    lastProbe = { at: new Date(now()).toISOString(), namespace: row.namespace, ...result };
  }

  // ── Główny serwer /mcp ────────────────────────────────────────────────────
  const app = Fastify({ logger: opts.logger ?? false });

  app.post('/mcp/:profileId', async (req: FastifyRequest, reply: FastifyReply) => {
    const profileId = (req.params as { profileId: string }).profileId;
    const token = extractBearer(req.headers.authorization);
    const authResult = token !== null ? auth.verify(token) : null;
    if (authResult === null) {
      auditAuthFailure(db, token, profileId, token === null ? 'missing_token' : 'invalid_token');
      return reply.code(401).send(rpcError(JSONRPC_UNAUTHORIZED, 'unauthorized'));
    }
    if (authResult.keyRow.profile_id !== profileId) {
      auditAuthFailure(db, token, profileId, 'profile_mismatch');
      return reply
        .code(403)
        .send(rpcError(JSONRPC_FORBIDDEN, 'forbidden: klucz nie jest przypisany do tego profilu'));
    }
    const rl = rateLimiter.check(`req:${authResult.keyRow.id}`, RATE_LIMIT_PER_MIN);
    if (!rl.ok) {
      return reply
        .code(429)
        .header('retry-after', String(rl.retryAfter))
        .send(rpcError(JSONRPC_RATE_LIMITED, 'rate_limited', { retryAfter: rl.retryAfter }));
    }
    const resolved = profiles.get(profileId);
    if (resolved === null) {
      // profil wyłączony/usunięty między weryfikacją klucza a odczytem profilu
      auditAuthFailure(db, token, profileId, 'profile_disabled');
      return reply.code(403).send(rpcError(JSONRPC_FORBIDDEN, 'forbidden: profil niedostępny'));
    }

    const ctx: ToolCtx = {
      db,
      profile: resolved.profile,
      keyRow: authResult.keyRow,
      allowedNamespaces: resolved.namespaces,
      scopes: authResult.scopes,
      llm: getLlm(),
      openspg,
      config,
      log: req.log as unknown as Logger,
    };
    const keyId = authResult.keyRow.id;
    const { server, transport } = createMcpPair({
      ctx,
      tools,
      checkToolRateLimit: (toolName) =>
        toolName === 'kb_answer'
          ? rateLimiter.check(`answer:${keyId}`, RATE_LIMIT_KB_ANSWER_PER_MIN)
          : { ok: true, retryAfter: 0 },
      onUsage: (event) => usage.append({ at: new Date(now()).toISOString(), keyId, ...event }),
    });

    // transport pisze bezpośrednio do surowej odpowiedzi — Fastify oddaje kontrolę
    reply.hijack();
    try {
      // cast: exactOptionalPropertyTypes vs interfejs Transport SDK (onclose?: () => void)
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'mcp: błąd obsługi żądania',
      );
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(JSON.stringify(rpcError(-32603, 'internal error')));
      } else {
        reply.raw.end();
      }
    } finally {
      void server.close().catch(() => undefined);
    }
  });

  // Spec Streamable HTTP w trybie stateless: brak GET-SSE i DELETE sesji → 405
  const methodNotAllowed = (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send(rpcError(-32000, 'method not allowed'));
  app.get('/mcp/*', methodNotAllowed);
  app.delete('/mcp/*', methodNotAllowed);
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.get('/healthz', () => ({
    ok: true,
    service: 'mcp-server',
    version: config.version,
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get('/readyz', (_req, reply) => {
    const checks = {
      db: false,
      migrations: false,
      profilesEnabled: false,
      searchProbe: lastProbe,
    };
    let migrationId = 0;
    try {
      db.prepare('SELECT 1').get();
      checks.db = true;
      migrationId = currentMigrationId(db);
    } catch {
      checks.db = false;
    }
    try {
      checkMigrations(db, migrationsDir);
      checks.migrations = true;
    } catch {
      checks.migrations = false;
    }
    try {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM mcp_profiles WHERE enabled = 1')
        .get() as { n: number };
      checks.profilesEnabled = row.n > 0;
    } catch {
      checks.profilesEnabled = false;
    }
    const ok = checks.db && checks.migrations && checks.profilesEnabled;
    return reply.code(ok ? 200 : 503).send({ ok, migrationId, checks });
  });

  // ── Serwer wewnętrzny (cache invalidate z panel-api; sieć wewnętrzna) ─────
  const internal = Fastify({ logger: opts.logger ?? false });
  internal.post('/invalidate', (req, reply) => {
    if (config.internalToken === null) {
      // fail-closed: bez skonfigurowanego sekretu endpoint nie działa w ogóle
      return reply
        .code(503)
        .send({ ok: false, error: { code: 'not_ready', message: 'INTERNAL_TOKEN nieskonfigurowany' } });
    }
    const presented = req.headers['x-internal-token'];
    if (typeof presented !== 'string' || !timingSafeEqualStr(presented, config.internalToken)) {
      return reply.code(401).send({ ok: false, error: { code: 'unauthorized', message: 'zły token' } });
    }
    invalidateCaches();
    return reply.send({ ok: true, data: { invalidated: ['auth', 'profiles', 'llm'] } });
  });

  return {
    app,
    internal,
    auth,
    profiles,
    rateLimiter,
    usage,
    getLastProbe: () => lastProbe,
    runProbe,
    invalidateCaches,
    close: async () => {
      auth.close(); // flush liczników użycia przed zamknięciem
      await app.close();
      await internal.close();
    },
  };
}

// ── Bootstrap (uruchomienie jako proces) ──────────────────────────────────────

export async function start(): Promise<void> {
  const config = loadConfig();
  // Fail-closed (checklista pkt 1/4): endpoint wewnętrzny /invalidate bez
  // skonfigurowanego sekretu wolno wystawić TYLKO na loopback — inaczej odmowa startu.
  const loopback = new Set(['127.0.0.1', '::1', 'localhost']);
  if (config.internalToken === null && !loopback.has(config.host)) {
    throw new Error(
      `mcp-server: INTERNAL_TOKEN nieskonfigurowany a HOST=${config.host} poza loopback — odmowa startu`,
    );
  }
  const db = openDb(config.dbPath);
  // Migracje uruchamia WYŁĄCZNIE panel-api; rozjazd wersji = odmowa startu.
  checkMigrations(db, sharedMigrationsDir());

  const bundle = buildServer({
    db,
    config,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });
  await bundle.app.listen({ port: config.port, host: config.host });
  await bundle.internal.listen({ port: config.internalPort, host: config.host });

  void bundle.runProbe().catch(() => undefined);
  const probeTimer = setInterval(() => {
    void bundle.runProbe().catch(() => undefined);
  }, PROBE_INTERVAL_MS);
  probeTimer.unref();

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    clearInterval(probeTimer);
    void bundle
      .close()
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  start().catch((err: unknown) => {
    console.error('mcp-server: start nieudany:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
