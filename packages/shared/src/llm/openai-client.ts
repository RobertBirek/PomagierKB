import OpenAI, { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { AppError, UpstreamError } from '../errors.js';
import { extractJsonObject } from './untrusted.js';

/**
 * Klient LLM (OpenAI-compatible) dla chat/openie/embeddings.
 * Twarde zasady: nigdy nie logujemy klucza API ani treści promptów — wyłącznie
 * model, czas trwania i liczby tokenów z usage (gdy serwer je zwraca).
 */

/** Minimalny interfejs loggera (kompatybilny z pino). */
export interface LlmLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface LlmClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Model używany przez chat ORAZ embed (osobne instancje klienta per cel z settings). */
  model: string;
  /** Timeout pojedynczego żądania HTTP w ms (default 60000). */
  timeoutMs?: number;
  logger?: LlmLogger;
  /** Wstrzykiwane w testach zamiast globalnego fetch. */
  fetch?: typeof globalThis.fetch;
  /** Odstęp między próbami — wstrzykiwane w testach, by nie czekać naprawdę. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ChatRequest {
  system: string;
  user: string;
  /** JSON Schema oczekiwanego wyniku — włącza structured outputs (response_format json_schema). */
  jsonSchema?: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  /** Obiekt sparsowany z odpowiedzi — tylko gdy podano jsonSchema i parse się powiódł. */
  parsed?: Record<string, unknown>;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResult>;
  embed(texts: string[]): Promise<number[][]>;
}

const RETRY_BASE_DELAY_MS = 500;
const RETRY_JITTER_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry wyłącznie na 429/5xx/timeout/błąd sieci — nigdy na pozostałe 4xx ani abort. */
function isRetryable(err: unknown): boolean {
  if (err instanceof APIUserAbortError) return false;
  if (!(err instanceof APIError)) return false;
  // status === undefined → APIConnectionError/timeout (sieć), traktowane jak przejściowe
  return err.status === undefined || err.status === 429 || err.status >= 500;
}

/** Mapowanie na katalog błędów aplikacji — bez przenoszenia treści promptu. */
function mapLlmError(err: unknown, endpoint: string): Error {
  if (err instanceof AppError) return err;
  if (err instanceof APIConnectionTimeoutError) {
    return new AppError('upstream_timeout', `LLM ${endpoint}: timeout`, { service: 'llm', endpoint });
  }
  if (err instanceof APIError) {
    return new UpstreamError('llm', endpoint, err.status, err.message);
  }
  return new UpstreamError('llm', endpoint, undefined, err instanceof Error ? err.message : String(err));
}

export function createLlmClient(cfg: LlmClientConfig): LlmClient {
  const { model, logger } = cfg;
  const sleep = cfg.sleep ?? defaultSleep;
  const client = new OpenAI({
    baseURL: cfg.baseUrl,
    apiKey: cfg.apiKey,
    timeout: cfg.timeoutMs ?? 60_000,
    maxRetries: 0, // retry robimy sami: dokładnie 1 ponowienie, kontrolowany odstęp
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
  });

  /** Jedno ponowienie na błąd przejściowy, z odstępem 500 ms + jitter. */
  async function withRetry<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      const status = err instanceof APIError ? (err.status ?? null) : null;
      logger?.warn({ model, endpoint, status }, 'llm: błąd przejściowy, ponawiam raz');
      await sleep(RETRY_BASE_DELAY_MS + Math.floor(Math.random() * RETRY_JITTER_MS));
      return fn();
    }
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ];
    const schema = req.jsonSchema; // const → narrowing działa też w domknięciach
    const startedAt = Date.now();
    let completion: OpenAI.ChatCompletion;

    if (schema) {
      try {
        completion = await withRetry('chat', () =>
          client.chat.completions.create({
            model,
            messages,
            response_format: { type: 'json_schema', json_schema: { name: 'result', schema } },
          }),
        );
      } catch (err) {
        // Serwer nie wspiera json_schema → 400; jedna ponowna próba z json_object + własny parse.
        if (!(err instanceof APIError) || err.status !== 400) throw mapLlmError(err, 'chat');
        logger?.warn({ model }, 'llm: json_schema odrzucone (400) — fallback json_object');
        try {
          completion = await withRetry('chat', () =>
            client.chat.completions.create({ model, messages, response_format: { type: 'json_object' } }),
          );
        } catch (err2) {
          throw mapLlmError(err2, 'chat');
        }
      }
    } else {
      try {
        completion = await withRetry('chat', () => client.chat.completions.create({ model, messages }));
      } catch (err) {
        throw mapLlmError(err, 'chat');
      }
    }

    const text = completion.choices[0]?.message?.content ?? '';
    const result: ChatResult = { text };
    if (schema) {
      const parsed = parseJsonLenient(text);
      if (parsed !== undefined) result.parsed = parsed;
    }
    const usage = completion.usage;
    if (usage) {
      result.usage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
    }
    logger?.info(
      {
        model,
        ms: Date.now() - startedAt,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
      },
      'llm: chat zakończony',
    );
    return result;
  }

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const startedAt = Date.now();
    let res: OpenAI.CreateEmbeddingResponse;
    try {
      res = await withRetry('embeddings', () =>
        client.embeddings.create({ model, input: texts, encoding_format: 'float' }),
      );
    } catch (err) {
      throw mapLlmError(err, 'embeddings');
    }
    // Kolejność wg pola index — API nie gwarantuje kolejności elementów data.
    const byIndex: (number[] | undefined)[] = new Array<number[] | undefined>(texts.length);
    for (const d of res.data) byIndex[d.index] = d.embedding;
    const vectors = byIndex.map((v, i) => {
      if (!v) throw new UpstreamError('llm', 'embeddings', undefined, `brak wektora dla elementu ${i}`);
      return v;
    });
    logger?.info(
      { model, ms: Date.now() - startedAt, promptTokens: res.usage?.prompt_tokens ?? null, count: vectors.length },
      'llm: embed zakończony',
    );
    return vectors;
  }

  return { chat, embed };
}

/** Parse odpowiedzi JSON: najpierw wprost, potem defensywnie (extractJsonObject). */
function parseJsonLenient(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* spróbuj wyciągnąć blok JSON */
  }
  return extractJsonObject(text);
}
