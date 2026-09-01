import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Konfiguracja panel-api walidowana przy starcie (fail-closed: brak wymaganej
 * wartości = czytelny błąd i proces NIE startuje). Bez @fastify/env — prosty
 * walidator z wzorcem "env lub *_FILE" (Docker secrets).
 *
 * Tryb testowy: wszystko wstrzykiwalne — loadConfig(env) przyjmuje dowolny
 * słownik zamiast process.env, a makeTestConfig() daje gotowy AppConfig
 * z bezpiecznymi wartościami do testów (bez dotykania env).
 */

export type NodeEnv = 'production' | 'development' | 'test';

export interface AppConfig {
  nodeEnv: NodeEnv;
  /** Katalog danych (SQLite, logi akcji, uploady, eksporty). */
  dataDir: string;
  port: number;
  host: string;
  /** Publiczny origin panelu, np. https://kag.ilovelighting.sanok.pl (bez trailing slash). */
  publicUrl: string;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
  };
  /** Sekret do podpisywania/sealowania cookie (min 32 znaki). */
  sessionSecret: string;
  /** Klucz AES-256-GCM do sessions.tokens_enc — dokładnie 32 bajty (base64 w env). */
  tokenEncKey: Buffer;
  openspg: {
    baseUrl: string;
    account: string;
    password: string;
  };
  stirlingUrl: string;
  tikaUrl: string;
  /** Sekret współdzielony panel-api ↔ mcp-server (invalidacja cache kluczy). */
  internalToken: string;
  /** Wewnętrzny URL mcp-servera (POST /invalidate po rotate/revoke klucza). */
  mcpInternalUrl: string;
  /** URL healthchecku mcp-servera (cockpit /api/v1/status i GET /mcp/health). */
  mcpHealthUrl: string;
  /** Katalog statyk frontu (WEB_DIST); brak katalogu → tryb tylko-API. */
  webDist: string;
  /** Limity rate-limitera (req/min) — nadpisywalne w testach małymi wartościami. */
  rateLimits: {
    global: number;
    auth: number;
    mutation: number;
  };
}

/** Błąd konfiguracji startowej — komunikat wymienia WSZYSTKIE problemy naraz. */
export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(
      'Nieprawidłowa konfiguracja środowiska panel-api:\n' +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/**
 * Wzorzec 'env lub *_FILE': jeżeli X jest ustawione (niepuste) — bierzemy X;
 * inaczej gdy X_FILE wskazuje plik — czytamy jego zawartość (trim).
 * Zwraca undefined gdy brak obu wariantów.
 */
function readSecret(env: Env, name: string, problems: string[]): string | undefined {
  const direct = env[name];
  if (direct !== undefined && direct !== '') return direct;
  const file = env[`${name}_FILE`];
  if (file !== undefined && file !== '') {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (err) {
      problems.push(`${name}_FILE: nie można odczytać pliku '${file}' (${(err as Error).message})`);
      return undefined;
    }
  }
  return undefined;
}

function requireValue(
  env: Env,
  name: string,
  problems: string[],
  { fileVariant = false }: { fileVariant?: boolean } = {},
): string {
  const value = fileVariant ? readSecret(env, name, problems) : env[name];
  if (value === undefined || value === '') {
    problems.push(fileVariant ? `brak wymaganej zmiennej ${name} (lub ${name}_FILE)` : `brak wymaganej zmiennej ${name}`);
    return '';
  }
  return value;
}

function parsePort(env: Env, name: string, fallback: number, problems: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    problems.push(`${name}: '${raw}' nie jest poprawnym numerem portu (0-65535)`);
    return fallback;
  }
  return n;
}

/**
 * Waliduje i buduje konfigurację z podanego środowiska (domyślnie process.env).
 * Fail-closed: jakikolwiek problem → ConfigError z pełną listą braków.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const problems: string[] = [];

  const nodeEnvRaw = env['NODE_ENV'] ?? 'production';
  if (!['production', 'development', 'test'].includes(nodeEnvRaw)) {
    problems.push(`NODE_ENV: '${nodeEnvRaw}' spoza dozwolonych (production|development|test)`);
  }

  const dataDir = env['DATA_DIR'] !== undefined && env['DATA_DIR'] !== '' ? env['DATA_DIR'] : '/data';
  const port = parsePort(env, 'PORT', 8080, problems);
  const host = env['HOST'] !== undefined && env['HOST'] !== '' ? env['HOST'] : '0.0.0.0';

  const publicUrl = requireValue(env, 'PUBLIC_URL', problems).replace(/\/+$/, '');

  const oidcIssuer = requireValue(env, 'OIDC_ISSUER', problems);
  const oidcClientId = requireValue(env, 'OIDC_CLIENT_ID', problems);
  const oidcClientSecret = requireValue(env, 'OIDC_CLIENT_SECRET', problems, { fileVariant: true });

  const sessionSecret = requireValue(env, 'SESSION_SECRET', problems, { fileVariant: true });
  if (sessionSecret !== '' && sessionSecret.length < 32) {
    problems.push('SESSION_SECRET: wymagane co najmniej 32 znaki');
  }

  const tokenEncKeyB64 = requireValue(env, 'TOKEN_ENC_KEY', problems, { fileVariant: true });
  let tokenEncKey = Buffer.alloc(0);
  if (tokenEncKeyB64 !== '') {
    tokenEncKey = Buffer.from(tokenEncKeyB64, 'base64');
    if (tokenEncKey.length !== 32) {
      problems.push(
        `TOKEN_ENC_KEY: po dekodowaniu base64 oczekiwano 32 bajtów, otrzymano ${tokenEncKey.length}`,
      );
    }
  }

  const openspgBaseUrl = requireValue(env, 'OPENSPG_BASE_URL', problems);
  const openspgAccount = requireValue(env, 'OPENSPG_ACCOUNT', problems, { fileVariant: true });
  const openspgPassword = requireValue(env, 'OPENSPG_PASSWORD', problems, { fileVariant: true });

  const stirlingUrl = requireValue(env, 'STIRLING_URL', problems);
  const tikaUrl = requireValue(env, 'TIKA_URL', problems);
  const internalToken = requireValue(env, 'INTERNAL_TOKEN', problems, { fileVariant: true });

  // Adresy mcp-servera — opcjonalne, z defaultami sieci wewnętrznej stacku kag.
  const mcpInternalUrl = (
    env['MCP_INTERNAL_URL'] !== undefined && env['MCP_INTERNAL_URL'] !== ''
      ? env['MCP_INTERNAL_URL']
      : 'http://kag-mcp:8091'
  ).replace(/\/+$/, '');
  const mcpHealthUrl =
    env['MCP_HEALTH_URL'] !== undefined && env['MCP_HEALTH_URL'] !== ''
      ? env['MCP_HEALTH_URL']
      : 'http://kag-mcp:3001/healthz';

  const webDist =
    env['WEB_DIST'] !== undefined && env['WEB_DIST'] !== ''
      ? env['WEB_DIST']
      : resolve('apps/panel-web/dist');

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    nodeEnv: nodeEnvRaw as NodeEnv,
    dataDir,
    port,
    host,
    publicUrl,
    oidc: { issuer: oidcIssuer, clientId: oidcClientId, clientSecret: oidcClientSecret },
    sessionSecret,
    tokenEncKey,
    openspg: { baseUrl: openspgBaseUrl, account: openspgAccount, password: openspgPassword },
    stirlingUrl,
    tikaUrl,
    internalToken,
    mcpInternalUrl,
    mcpHealthUrl,
    webDist,
    rateLimits: { global: 300, auth: 10, mutation: 60 },
  };
}

/**
 * Gotowa konfiguracja do testów (vitest) — bez czytania env, wszystkie wartości
 * bezpieczne i deterministyczne. Nadpisania płytkie: obiekt zagnieżdżony
 * (oidc/openspg/rateLimits) podajemy w całości.
 */
export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    dataDir: join(tmpdir(), 'pomagierkb-test'),
    port: 0,
    host: '127.0.0.1',
    publicUrl: 'https://kag.test',
    oidc: {
      issuer: 'https://auth.test/application/o/kag-panel/',
      clientId: 'kag-panel',
      clientSecret: 'test-client-secret',
    },
    sessionSecret: 'test-session-secret-0123456789abcdef',
    tokenEncKey: Buffer.alloc(32, 7),
    openspg: { baseUrl: 'http://openspg.test:8887', account: 'openspg', password: 'openspg' },
    stirlingUrl: 'http://stirling.test:8080',
    tikaUrl: 'http://tika.test:9998',
    internalToken: 'test-internal-token',
    mcpInternalUrl: 'http://kag-mcp.test:8091',
    mcpHealthUrl: 'http://kag-mcp.test:3001/healthz',
    webDist: join(tmpdir(), 'pomagierkb-test-web-dist-nonexistent'),
    rateLimits: { global: 300, auth: 10, mutation: 60 },
    ...overrides,
  };
}
