import type { Db } from '@pomagierkb/shared/db';
import { SETTINGS_KEYS, getSetting, maskForApi, setSetting, type MaskedSetting, type SettingsKey } from '@pomagierkb/shared/db';
import { seal as sealAesGcm, unseal as unsealAesGcm } from '@pomagierkb/shared/crypto';
import { AppError } from '@pomagierkb/shared/errors';
import { createLlmClient, withBreaker, type LlmClient } from '@pomagierkb/shared/llm';
import type { AppConfig } from '../config.js';

/**
 * Serwis ustawień: odczyt zamaskowany (sekrety nigdy w pełnej postaci w API),
 * zapis z sealowaniem AES-GCM (TOKEN_ENC_KEY) przez DI seal/unseal z shared/crypto
 * oraz test połączenia LLM (krótkie wywołanie pod breakerem shared/llm).
 */

/** Klucze sekretne (konfiguracje LLM z polem apiKey) — sealowane przed zapisem. */
const SECRET_KEYS: readonly SettingsKey[] = ['llm.chat', 'llm.openie', 'llm.embeddings'];

export function isSecretKey(key: SettingsKey): boolean {
  return SECRET_KEYS.includes(key);
}

/** Funkcje seal/unseal na kluczu TOKEN_ENC_KEY z configu (Buffer → base64). */
function cryptoFns(config: AppConfig): { seal: (p: string) => string; unseal: (s: string) => string } {
  const keyB64 = config.tokenEncKey.toString('base64');
  return {
    seal: (plaintext) => sealAesGcm(plaintext, keyB64),
    unseal: (sealed) => unsealAesGcm(sealed, keyB64),
  };
}

/** GET /settings — WSZYSTKIE klucze białej listy, sekrety wyłącznie {configured,preview}. */
export function listSettings(db: Db, config: AppConfig): Record<string, MaskedSetting> {
  const { unseal } = cryptoFns(config);
  const out: Record<string, MaskedSetting> = {};
  for (const key of SETTINGS_KEYS) {
    // Uszkodzony sekret (np. zmieniony TOKEN_ENC_KEY) nie może zabić całego GET —
    // pokazujemy configured bez preview.
    try {
      out[key] = maskForApi(db, key, { unseal });
    } catch {
      out[key] = maskForApi(db, key);
    }
  }
  return out;
}

/**
 * PUT /settings/:key — zapis wartości; dla kluczy sekretnych:
 * - wartość sealowana AES-GCM przed zapisem (nigdy plaintext w DB);
 * - puste pole sekretne (apiKey === '') = BEZ ZMIANY — scalamy z poprzednią
 *   wartością, żeby UI mógł poprawić baseUrl/model bez ponownego wpisywania klucza.
 * Zwraca kształt zamaskowany (nigdy pełny sekret).
 */
export function putSetting(
  db: Db,
  config: AppConfig,
  key: SettingsKey,
  value: unknown,
  updatedBy: string | null,
): MaskedSetting {
  const { seal, unseal } = cryptoFns(config);
  const secret = isSecretKey(key);
  let toStore = value;

  if (secret) {
    if (typeof toStore !== 'object' || toStore === null || Array.isArray(toStore)) {
      throw new AppError('validation_error', `ustawienie ${key} wymaga obiektu konfiguracji {baseUrl, apiKey, model}`);
    }
    const obj = { ...(toStore as Record<string, unknown>) };
    if (obj['apiKey'] === '' || obj['apiKey'] === undefined) {
      // Pusty sekret = bez zmiany: dociągamy poprzedni apiKey (jeśli istnieje).
      let previous: unknown = null;
      try {
        previous = getSetting(db, key, { unseal })?.value ?? null;
      } catch {
        previous = null; // nieodszyfrowywalny stary sekret — traktujemy jak brak
      }
      const prevKey =
        typeof previous === 'object' && previous !== null
          ? (previous as Record<string, unknown>)['apiKey']
          : undefined;
      if (typeof prevKey === 'string' && prevKey !== '') {
        obj['apiKey'] = prevKey;
      } else {
        throw new AppError('validation_error', `ustawienie ${key}: brak apiKey (i brak zapisanego wcześniej)`);
      }
    }
    toStore = obj;
  }

  setSetting(db, key, toStore, { isSecret: secret, seal, updatedBy });
  return secret ? maskForApi(db, key, { unseal }) : maskForApi(db, key);
}

// ── Test połączenia LLM ─────────────────────────────────────────────────────

export type LlmTarget = 'chat' | 'openie' | 'embeddings';

export interface TestLlmResult {
  ok: true;
  model: string;
  latencyMs: number;
}

interface LlmSettingsShape {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function coerceLlmSettings(value: unknown): LlmSettingsShape | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  const baseUrl = o['baseUrl'];
  const apiKey = o['apiKey'];
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

export interface TestLlmDeps {
  /** Fabryka klienta LLM — wstrzykiwana w testach (default: shared/llm). */
  makeClient?: (cfg: LlmSettingsShape) => LlmClient;
}

/**
 * POST /settings/test-llm — krótkie wywołanie wskazanego celu pod breakerem
 * `llm.<target>`. Sukces → {ok, model, latencyMs}; błąd upstreamu propaguje
 * AppError (502 upstream_error / 504 upstream_timeout / 503 not_ready z breakera).
 */
export async function testLlm(
  db: Db,
  config: AppConfig,
  target: LlmTarget,
  deps: TestLlmDeps = {},
): Promise<TestLlmResult> {
  const key = `llm.${target}` as SettingsKey;
  const { unseal } = cryptoFns(config);
  let cfg: LlmSettingsShape | null = null;
  try {
    cfg = coerceLlmSettings(getSetting(db, key, { unseal })?.value);
  } catch {
    cfg = null;
  }
  if (cfg === null) {
    throw new AppError('not_ready', `LLM ${target} nie jest skonfigurowany (ustawienie ${key})`);
  }

  const makeClient =
    deps.makeClient ??
    ((c: LlmSettingsShape) =>
      createLlmClient({ baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, timeoutMs: 15_000 }));
  const client = makeClient(cfg);

  const startedAt = Date.now();
  await withBreaker(db, key, async () => {
    if (target === 'embeddings') {
      await client.embed(['ping']);
    } else {
      await client.chat({ system: 'Odpowiadaj jednym słowem.', user: 'ping' });
    }
  });
  return { ok: true, model: cfg.model, latencyMs: Date.now() - startedAt };
}
