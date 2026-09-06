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
  trustProxyOption,
  type McpConfig,
} from './config.js';
import {
  AuthFailureAggregator,
  AuthService,
  auditAuthFailure,
  extractBearer,
  isValidProfileId,
  tokenPrefix,
} from './auth.js';
import { ProfileCache } from './profiles.js';
import { RATE_LIMIT_PER_MIN, RateLimiter, requestCost, toolRateRule } from './rate-limit.js';
import { UsageLog } from './usage-log.js';
import {
  JSONRPC_FORBIDDEN,
  JSONRPC_RATE_LIMITED,
  JSONRPC_UNAUTHORIZED,
  createMcpPair,
  createModernHandler,
  isLegacyRequest,
  toNodeHandler,
} from './mcp.js';
import { allTools } from './tools/index.js';
import type { KbTool, ToolCtx, ToolLlm } from './tools/types.js';

/**
 * Shell HTTP mcp-servera (§7.1): POST /mcp/:profileId → auth → profil → fabryka
 * McpServer+transport per żądanie → transport.handleRequest. GET|DELETE → 405.
 * /healthz, /readyz; wewnętrzny serwer :INTERNAL_PORT z POST /invalidate.
 */

const LLM_CACHE_TTL_MS = 60_000;
const PROBE_INTERVAL_MS = 600_000;
/**
 * Limit nieudanych uwierzytelnień per adres źródłowy — przed auth nie ma klucza,
 * po którym można limitować, a każde 401/403 dotykało łańcucha audytu na SQLite
 * współdzielonym z panel-api. Ruch legalny nigdy tu nie trafia (401/403 = błąd klienta).
 */
const AUTH_FAILURE_PER_IP_PER_MIN = 20;
/** Limit nieudanych prób na wewnętrznym /invalidate (zgadywanie X-Internal-Token). */
const INVALIDATE_FAILURE_PER_IP_PER_MIN = 10;
/**
 * Największe legalne wejście to kb_submit_draft (content 100 000 znaków — do ~200 KB
 * w UTF-8 z polskimi znakami). 512 KB daje zapas, a jednocześnie ścina domyślny
 * 1 MiB Fastify (dwukrotnie mniej wiadomości w jednym batchu JSON-RPC do sparsowania).
 */
const MCP_BODY_LIMIT_BYTES = 512 * 1024;

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
  const authFailures = new AuthFailureAggregator(60_000, now);
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
        "SELECT namespace, project_id FROM kb_registry WHERE status = 'active' AND project_id IS NOT NULL ORDER BY is_default DESC, namespace LIMIT 1",
      )
      .get() as { namespace: string; project_id: number } | undefined;
    if (row === undefined) return; // brak aktywnych, sprovisionowanych KB — sonda nie ma czego sprawdzić
    // Realny projectId (bez niego OpenSPG szuka w projekcie 0 → sonda kłamała) i realny
    // wektor z embeddings, gdy LLM skonfigurowany (wektor zerowy → odrzut przez wymiar).
    let queryVector: number[] | undefined;
    try {
      const llm = buildToolLlm(db, config);
      if (llm !== null) [queryVector] = await llm.embed(['sonda']);
    } catch {
      queryVector = undefined; // brak LLM/embeddingu → uczciwe vectorOk=false z wektorem zerowym
    }
    const result = await probeSearch(openspg, row.namespace, {
      projectId: row.project_id,
      ...(queryVector !== undefined && queryVector.length > 0 ? { queryVector } : {}),
    });
    lastProbe = { at: new Date(now()).toISOString(), namespace: row.namespace, ...result };
  }

  // ── Główny serwer /mcp ────────────────────────────────────────────────────
  const trustProxy = trustProxyOption(config.trustProxyHops);
  const app = Fastify({
    logger: opts.logger ?? false,
    // Za Caddy: req.ip = adres klienta z X-Forwarded-For (limiter per IP przed auth)
    trustProxy,
  });

  /**
   * Wspólna ścieżka odmowy przed/na etapie auth (401/403). Kolejność jest istotna:
   * najpierw limiter per IP (odcina zalew z internetu), dopiero potem — i tylko dla
   * pierwszego wystąpienia w oknie — wpis do łańcucha audytu.
   */
  function denyAuth(
    req: FastifyRequest,
    reply: FastifyReply,
    status: 401 | 403,
    code: number,
    message: string,
    profileId: string,
    token: string | null,
    reason: string,
  ): FastifyReply {
    const ip = req.ip;
    const ipLimit = rateLimiter.check(`authfail:${ip}`, AUTH_FAILURE_PER_IP_PER_MIN);
    if (!ipLimit.ok) {
      req.log.warn({ ip, profileId, reason }, 'mcp: zalew nieudanych auth z jednego adresu');
      return reply
        .code(429)
        .header('retry-after', String(ipLimit.retryAfter))
        .send(rpcError(JSONRPC_RATE_LIMITED, 'rate_limited', { retryAfter: ipLimit.retryAfter }));
    }
    const prefix = tokenPrefix(token);
    const decision = authFailures.record(`${prefix}|${ip}|${reason}`);
    req.log.warn({ ip, profileId, reason, keyPrefix: prefix }, 'mcp: nieudane uwierzytelnienie');
    if (decision.audit) {
      auditAuthFailure(db, token, profileId, reason, {
        ip,
        ...(decision.suppressed > 0 ? { suppressed: decision.suppressed } : {}),
      });
    }
    return reply.code(status).send(rpcError(code, message));
  }

  const mcpRouteOptions = { bodyLimit: MCP_BODY_LIMIT_BYTES };

  app.post('/mcp/:profileId', mcpRouteOptions, async (req: FastifyRequest, reply: FastifyReply) => {
    const profileId = (req.params as { profileId: string }).profileId;
    // Segment z URL trafia do audytu jako resourceId — waliduj PRZED czymkolwiek
    if (!isValidProfileId(profileId)) {
      req.log.warn({ ip: req.ip }, 'mcp: żądanie na niepoprawny identyfikator profilu');
      return reply.code(404).send(rpcError(JSONRPC_FORBIDDEN, 'forbidden: profil niedostępny'));
    }
    const token = extractBearer(req.headers.authorization);
    const authResult = token !== null ? auth.verify(token) : null;
    if (authResult === null) {
      return denyAuth(
        req,
        reply,
        401,
        JSONRPC_UNAUTHORIZED,
        'unauthorized',
        profileId,
        token,
        token === null ? 'missing_token' : 'invalid_token',
      );
    }
    if (authResult.keyRow.profile_id !== profileId) {
      return denyAuth(
        req,
        reply,
        403,
        JSONRPC_FORBIDDEN,
        'forbidden: klucz nie jest przypisany do tego profilu',
        profileId,
        token,
        'profile_mismatch',
      );
    }
    // Batch JSON-RPC (era 2025, SDK v1) wykonuje KAŻDĄ wiadomość tablicy — limiter
    // musi liczyć wywołania, nie żądania HTTP, inaczej batch omija 60/min N-krotnie.
    const rl = rateLimiter.check(
      `req:${authResult.keyRow.id}`,
      RATE_LIMIT_PER_MIN,
      60_000,
      requestCost(req.body),
    );
    if (!rl.ok) {
      return reply
        .code(429)
        .header('retry-after', String(rl.retryAfter))
        .send(rpcError(JSONRPC_RATE_LIMITED, 'rate_limited', { retryAfter: rl.retryAfter }));
    }
    const resolved = profiles.get(profileId);
    if (resolved === null) {
      // profil wyłączony/usunięty między weryfikacją klucza a odczytem profilu
      return denyAuth(
        req,
        reply,
        403,
        JSONRPC_FORBIDDEN,
        'forbidden: profil niedostępny',
        profileId,
        token,
        'profile_disabled',
      );
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
    const pairOpts = {
      ctx,
      tools,
      // Limity narzędziowe dla wywołań o realnym koszcie zewnętrznym (LLM/OpenSPG):
      // kb_answer i kb_claim_verify 10/min, kb_search vector/hybrid 30/min.
      checkToolRateLimit: (toolName: string, input: unknown) => {
        const rule = toolRateRule(toolName, input);
        if (rule === null) return { ok: true, retryAfter: 0 };
        return rateLimiter.check(`${rule.bucket}:${keyId}`, rule.limit);
      },
      onUsage: (event: Parameters<NonNullable<Parameters<typeof createMcpPair>[0]['onUsage']>>[0]) =>
        usage.append({ at: new Date(now()).toISOString(), keyId, ...event }),
    };

    // ── Routing er protokołu (wzorzec z dokumentacji SDK v2): ruch 2025 (bez
    // envelope _meta) → sprawdzona ścieżka v1 — BAJTOWO identyczna z dotychczasową
    // (Claude Code/Cursor bez zmian); ruch 2026-07-28 → handler v2 (server/discover,
    // resultType, cache hints, walidacja Mcp-Method/Mcp-Name z -32020). ─────────
    const probe = new Request(`http://mcp.local${req.url}`, {
      method: 'POST',
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([, v]) => typeof v === 'string') as [string, string][],
      ),
    });
    const legacy = await isLegacyRequest(probe, req.body);

    // transport pisze bezpośrednio do surowej odpowiedzi — Fastify oddaje kontrolę
    reply.hijack();
    if (legacy) {
      const { server, transport } = createMcpPair(pairOpts);
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
      return;
    }

    const handler = createModernHandler(pairOpts);
    try {
      // cast: exactOptionalPropertyTypes vs NodeIncomingMessageLike (method?: string)
      await toNodeHandler(handler)(
        req.raw as unknown as Parameters<ReturnType<typeof toNodeHandler>>[0],
        reply.raw,
        req.body,
      );
    } catch (err) {
      req.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'mcp(v2): błąd obsługi żądania',
      );
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(JSON.stringify(rpcError(-32603, 'internal error')));
      } else {
        reply.raw.end();
      }
    } finally {
      void handler.close().catch(() => undefined);
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
  const internal = Fastify({ logger: opts.logger ?? false, trustProxy });
  internal.post('/invalidate', (req, reply) => {
    if (config.internalToken === null) {
      // fail-closed: bez skonfigurowanego sekretu endpoint nie działa w ogóle
      return reply
        .code(503)
        .send({ ok: false, error: { code: 'not_ready', message: 'INTERNAL_TOKEN nieskonfigurowany' } });
    }
    const presented = req.headers['x-internal-token'];
    if (typeof presented !== 'string' || !timingSafeEqualStr(presented, config.internalToken)) {
      // Listener jest widoczny dla wszystkich kontenerów w sieciach kag-mcp (w tym
      // nie-hardenowanych OpenSPG) — bez limitu zgadywanie sekretu byłoby darmowe.
      const ipLimit = rateLimiter.check(
        `invalidate:${req.ip}`,
        INVALIDATE_FAILURE_PER_IP_PER_MIN,
      );
      if (!ipLimit.ok) {
        req.log.warn({ ip: req.ip }, 'internal: zalew nieudanych prób /invalidate');
        return reply
          .code(429)
          .header('retry-after', String(ipLimit.retryAfter))
          .send({ ok: false, error: { code: 'rate_limited', message: 'zbyt wiele prób' } });
      }
      req.log.warn({ ip: req.ip }, 'internal: zły X-Internal-Token na /invalidate');
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
  if (config.internalToken === null && !loopback.has(config.internalHost)) {
    throw new Error(
      `mcp-server: INTERNAL_TOKEN nieskonfigurowany a INTERNAL_HOST=${config.internalHost} poza loopback — odmowa startu`,
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
  // Listener wewnętrzny osobno: INTERNAL_HOST pozwala zejść z 0.0.0.0 na adres
  // sieci kag-control, nie wystawiając /invalidate całej sieci kontenerów.
  await bundle.internal.listen({ port: config.internalPort, host: config.internalHost });

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
