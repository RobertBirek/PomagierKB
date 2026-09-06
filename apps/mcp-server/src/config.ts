import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Db } from '@pomagierkb/shared/db';
import { getSetting } from '@pomagierkb/shared/db';
import { unseal } from '@pomagierkb/shared/crypto';
import {
  createLlmClient,
  recordLlmUsage,
  withBreaker,
  type BreakerTransition,
  type LlmLogger,
} from '@pomagierkb/shared/llm';
import type { ToolLlm } from './tools/types.js';

/**
 * Konfiguracja mcp-servera. ENV tylko dla transportu/ścieżek/sekretów infra;
 * ustawienia LLM SĄ W DB (settings, sealed AES-GCM) — nigdy w .env (twarda zasada).
 */

export interface McpConfig {
  /** Katalog danych współdzielony z panel-api (default /data). */
  dataDir: string;
  /** Plik SQLite współdzielony z panel-api. */
  dbPath: string;
  /** Katalog usage-JSONL (DATA_DIR/mcp-usage). */
  usageDir: string;
  port: number;
  host: string;
  internalPort: number;
  /**
   * Adres nasłuchu serwera wewnętrznego (:INTERNAL_PORT z /invalidate). Domyślnie
   * = host, ale POWINIEN wskazywać adres z sieci kag-control (panel↔mcp): na
   * 0.0.0.0 endpoint jest widoczny dla wszystkich kontenerów w sieciach kag-mcp,
   * w tym nie-hardenowanych OpenSPG. Zmiana ENV, bez zmiany kodu.
   */
  internalHost: string;
  /**
   * Ile warstw proxy stoi przed mcp-serverem. Za Caddy = 1, dzięki czemu req.ip to
   * adres klienta z X-Forwarded-For — inaczej limiter nieudanych auth widziałby
   * jeden adres proxy dla całego internetu. 0 = nie ufaj nagłówkom w ogóle.
   */
  trustProxyHops: number;
  /** Sekret nagłówka X-Internal-Token dla POST /invalidate; null = endpoint odmawia (503). */
  internalToken: string | null;
  /** Publiczny URL serwera (snippety/diagnostyka); null gdy nieustawiony. */
  publicUrl: string | null;
  /** null = OpenSPG nieskonfigurowany → narzędzia degradują się do fallbacków. */
  openspg: { baseUrl: string; account: string; password: string } | null;
  /** Klucz AES-GCM (base64, 32B) do unseal sekretów settings; null = brak LLM. */
  tokenEncKey: string | null;
  version: string;
}

/** Wartość z ENV albo z pliku wskazanego w <NAME>_FILE (sekrety docker/compose). */
function readSecret(env: NodeJS.ProcessEnv, name: string): string | null {
  const direct = env[name];
  if (direct !== undefined && direct !== '') return direct;
  const file = env[`${name}_FILE`];
  if (file !== undefined && file !== '') return readFileSync(file, 'utf8').trim();
  return null;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`config: ${name} musi być liczbą całkowitą 0..65535, jest: ${raw}`);
  }
  return n;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** TRUST_PROXY: liczba warstw proxy ('false' = 0). Default 1 (Caddy). */
function trustProxyEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || raw === '') return 1;
  if (raw === 'false') return 0;
  if (raw === 'true') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 16) {
    throw new Error(`config: TRUST_PROXY musi być liczbą całkowitą 0..16 albo true/false, jest: ${raw}`);
  }
  return n;
}

/**
 * Opcja `trustProxy` Fastify z liczby przeskoków. Typy Fastify nie przyjmują liczby,
 * a semantyka liczby w proxy-addr to dokładnie „ufaj `hops` ostatnim przeskokom" —
 * odtwarzamy ją funkcją. false = req.ip zawsze z gniazda (X-Forwarded-For ignorowany).
 */
export function trustProxyOption(hops: number): boolean | ((address: string, hop: number) => boolean) {
  if (hops <= 0) return false;
  return (_address: string, hop: number) => hop < hops;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const dataDir = env.DATA_DIR !== undefined && env.DATA_DIR !== '' ? env.DATA_DIR : '/data';
  const openspgBaseUrl = env.OPENSPG_BASE_URL ?? '';
  const openspgAccount = env.OPENSPG_ACCOUNT ?? '';
  const openspgPassword = readSecret(env, 'OPENSPG_PASSWORD');
  const openspg =
    openspgBaseUrl !== '' && openspgAccount !== '' && openspgPassword !== null
      ? { baseUrl: openspgBaseUrl, account: openspgAccount, password: openspgPassword }
      : null;
  const host = env.HOST !== undefined && env.HOST !== '' ? env.HOST : '0.0.0.0';
  return {
    dataDir,
    dbPath: join(dataDir, 'db', 'kag.db'),  // ta sama ścieżka co panel-api (DATA_DIR/db/kag.db)
    usageDir: join(dataDir, 'mcp-usage'),
    port: intEnv(env, 'PORT', 3001),
    host,
    internalPort: intEnv(env, 'INTERNAL_PORT', 8091),
    internalHost: env.INTERNAL_HOST !== undefined && env.INTERNAL_HOST !== '' ? env.INTERNAL_HOST : host,
    trustProxyHops: trustProxyEnv(env),
    internalToken: readSecret(env, 'INTERNAL_TOKEN'),
    publicUrl: env.PUBLIC_URL !== undefined && env.PUBLIC_URL !== '' ? env.PUBLIC_URL : null,
    openspg,
    tokenEncKey: readSecret(env, 'TOKEN_ENC_KEY'),
    version: readVersion(),
  };
}

/** Katalog migracji SQL z dist packages/shared (mcp-server tylko sprawdza wersję). */
export function sharedMigrationsDir(): string {
  const req = createRequire(import.meta.url);
  return join(dirname(req.resolve('@pomagierkb/shared/db')), 'migrations');
}

// ── LLM z DB settings ───────────────────────────────────────────────────────

interface LlmSettingsShape {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Defensywny parse wartości ustawienia llm.* (tolerancja camelCase/snake_case). */
function coerceLlmSettings(value: unknown): LlmSettingsShape | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  const baseUrl = o['baseUrl'] ?? o['base_url'] ?? o['baseURL'];
  const apiKey = o['apiKey'] ?? o['api_key'] ?? o['key'];
  const model = o['model'];
  if (
    typeof baseUrl === 'string' && baseUrl !== '' &&
    typeof apiKey === 'string' && apiKey !== '' &&
    typeof model === 'string' && model !== ''
  ) {
    return { baseUrl, apiKey, model };
  }
  return null;
}

function readLlmSetting(
  db: Db,
  key: 'llm.chat' | 'llm.embeddings',
  tokenEncKey: string | null,
): LlmSettingsShape | null {
  try {
    const opts = tokenEncKey !== null ? { unseal: (s: string) => unseal(s, tokenEncKey) } : {};
    const setting = getSetting(db, key, opts);
    return coerceLlmSettings(setting?.value);
  } catch {
    // zły TOKEN_ENC_KEY / uszkodzony sekret / brak tabeli — traktujemy jak brak konfiguracji
    return null;
  }
}

/**
 * Buduje klienta LLM dla ToolCtx z DB settings (llm.chat + llm.embeddings).
 * Brak llm.chat (lub brak klucza unseal) → null — narzędzia degradują się jawnie.
 * Brak llm.embeddings → embed na konfiguracji chatu (uczciwe minimum; embeddings
 * do vector search i tak walidowane per KB przez embedding_model w rejestrze).
 */
export function buildToolLlm(db: Db, config: McpConfig, logger?: LlmLogger): ToolLlm | null {
  const chatCfg = readLlmSetting(db, 'llm.chat', config.tokenEncKey);
  if (chatCfg === null) return null;
  const embedCfg = readLlmSetting(db, 'llm.embeddings', config.tokenEncKey) ?? chatCfg;

  /**
   * GAP-05: rejestr kosztu wpięty W KLIENCIE. `withBreaker` widzi tylko wyniki
   * niosące `usage` (czat) — embeddingi zapytań kb_search/kb_answer wracają jako
   * `number[][]` i nie trafiały do rejestru w ogóle. Flaga `usageReported`
   * (openai-client) pilnuje, żeby czatu nie policzyć dwa razy.
   */
  const onUsage = (purpose: string) =>
    (event: {
      endpoint: 'chat' | 'embeddings';
      model: string;
      promptTokens: number | null;
      completionTokens: number | null;
    }): void => {
      recordLlmUsage(db, { ...event, purpose });
    };

  const chatClient = createLlmClient({
    baseUrl: chatCfg.baseUrl,
    apiKey: chatCfg.apiKey,
    model: chatCfg.model,
    ...(logger !== undefined ? { logger } : {}),
    onUsage: onUsage('mcp.chat'),
  });
  // Osobny klient nawet przy tej samej konfiguracji — inaczej embeddingi
  // raportowałyby się pod etykietą kosztu czatu.
  const embedClient = createLlmClient({
    baseUrl: embedCfg.baseUrl,
    apiKey: embedCfg.apiKey,
    model: embedCfg.model,
    ...(logger !== undefined ? { logger } : {}),
    onUsage: onUsage('mcp.embed'),
  });

  /** Przejścia breakerów do logu procesu (audyt zapisuje je niezależnie) — D8-10. */
  const breakerOpts =
    logger !== undefined
      ? {
          logger: (event: BreakerTransition): void => {
            logger.warn(
              {
                breaker: event.name,
                from: event.from,
                to: event.to,
                failureCount: event.failureCount,
                ...(event.cooldownMs !== undefined ? { cooldownMs: event.cooldownMs } : {}),
              },
              'breaker: zmiana stanu',
            );
          },
        }
      : {};

  // Breaker w gorącej ścieżce: awarie LLM otwierają 'llm.chat'/'llm.embeddings'
  // w tabeli breakers (kokpit widzi realny stan; otwarty → not_ready bez wołania API).
  return {
    chat: (req) => withBreaker(db, 'llm.chat', () => chatClient.chat(req), breakerOpts),
    embed: (texts) => withBreaker(db, 'llm.embeddings', () => embedClient.embed(texts), breakerOpts),
  };
}
