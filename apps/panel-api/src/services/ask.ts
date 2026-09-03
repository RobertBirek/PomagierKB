import type { Db } from '@pomagierkb/shared/db';
import {
  getAnswer,
  getSetting,
  listAnswersByUser,
  listKbs,
  recordFeedback,
  type FeedbackVerdict,
  type RecordFeedbackResult,
} from '@pomagierkb/shared/db';
import { unseal as unsealAesGcm } from '@pomagierkb/shared/crypto';
import { createLlmClient, withBreaker } from '@pomagierkb/shared/llm';
import { OpenSpgClient } from '@pomagierkb/shared/openspg';
import type { AnswerLlm } from '@pomagierkb/shared/answer';
import { AppError } from '@pomagierkb/shared/errors';
import type { AppConfig } from '../config.js';

/**
 * Serwis panelowego /ask (POST /api/v1/ask + historia + feedback):
 * - klient LLM budowany z DB settings (llm.chat / llm.embeddings, sealed AES-GCM,
 *   unseal kluczem TOKEN_ENC_KEY z configu) — CACHE per proces z inwalidacją
 *   przy PUT /settings: odcisk = updated_at wierszy llm.* w settings, więc każda
 *   zmiana ustawień (PUT /settings/:key nadpisuje updated_at) buduje klienta od
 *   nowa (spójny wzorzec z buildToolLlm + invalidate w mcp-server, bez potrzeby
 *   sięgania między modułami tras);
 * - klient OpenSPG z configu (jak services/status) — konstrukcja bez sieci;
 * - dodatkowy limit 10/min per sesja dla ask (koszt LLM — jak kb_answer w MCP);
 * - historia odpowiedzi użytkownika i feedback z bramką własności (404).
 */

// ── Limit ask per sesja (sliding window, pamięć procesu) ────────────────────

export const ASK_LIMIT_PER_MINUTE = 10;
const ASK_WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;

/** Czysta logika okna przesuwnego (jak RateLimiter mcp-servera). */
export class AskRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Rzuca rate_limited (429) po przekroczeniu limitu w oknie 60 s. */
  consume(bucket: string, limit = ASK_LIMIT_PER_MINUTE): void {
    const t = this.now();
    let hits = this.buckets.get(bucket);
    if (hits === undefined) {
      if (this.buckets.size >= MAX_BUCKETS) this.buckets.clear(); // bezpiecznik pamięci
      hits = [];
      this.buckets.set(bucket, hits);
    }
    while (hits.length > 0 && hits[0]! <= t - ASK_WINDOW_MS) hits.shift();
    if (hits.length >= limit) {
      const retryAfterMs = Math.max(1_000, hits[0]! + ASK_WINDOW_MS - t);
      throw new AppError(
        'rate_limited',
        `Przekroczono limit ${limit} pytań na minutę — spróbuj ponownie za ${Math.ceil(retryAfterMs / 1000)} s`,
        { max: limit, retryAfterMs },
      );
    }
    hits.push(t);
  }
}

// ── LLM z DB settings (cache z inwalidacją przez updated_at) ────────────────

interface LlmSettingsShape {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Defensywny parse wartości ustawienia llm.* (tolerancja camelCase/snake_case — jak mcp config). */
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

function readLlmSetting(db: Db, key: 'llm.chat' | 'llm.embeddings', tokenEncKeyB64: string): LlmSettingsShape | null {
  try {
    const setting = getSetting(db, key, { unseal: (sealed) => unsealAesGcm(sealed, tokenEncKeyB64) });
    return coerceLlmSettings(setting?.value);
  } catch {
    // zły TOKEN_ENC_KEY / uszkodzony sekret — traktujemy jak brak konfiguracji
    return null;
  }
}

/** Odcisk konfiguracji LLM: PUT /settings nadpisuje updated_at → cache nieważny. */
function llmFingerprint(db: Db): string {
  try {
    const rows = db
      .prepare("SELECT key, updated_at FROM settings WHERE key IN ('llm.chat','llm.embeddings') ORDER BY key")
      .all() as { key: string; updated_at: string }[];
    return rows.map((r) => `${r.key}@${r.updated_at}`).join('|');
  } catch {
    return '';
  }
}

export interface AskServiceDeps {
  db: Db;
  config: AppConfig;
  /** Fabryka klienta LLM — wstrzykiwana w testach (default: shared/llm). */
  makeLlmClient?: (cfg: LlmSettingsShape) => AnswerLlm;
  /** Fabryka klienta OpenSPG — wstrzykiwana w testach (null = niedostępny). */
  makeOpenspg?: () => OpenSpgClient | null;
}

export interface AskService {
  /** Klient LLM z settings; null = nieskonfigurowany (ask → 503 not_ready). */
  getLlm(): AnswerLlm | null;
  /** Klient OpenSPG z configu (retrieval degraduje się sam, gdy nie odpowiada). */
  getOpenspg(): OpenSpgClient | null;
  /** Limit 10/min per sesja — rzuca rate_limited PRZED hijackiem SSE. */
  consumeAskLimit(sessionKey: string): void;
}

export function createAskService(deps: AskServiceDeps): AskService {
  const { db, config } = deps;
  const tokenEncKeyB64 = config.tokenEncKey.toString('base64');
  const makeLlmClient =
    deps.makeLlmClient ?? ((cfg: LlmSettingsShape) => createLlmClient(cfg));
  const limiter = new AskRateLimiter();

  let llmCache: { fingerprint: string; value: AnswerLlm | null } | null = null;

  // OpenSPG budowany raz (konstruktor bez sieci; login leniwy w kliencie).
  const openspg: OpenSpgClient | null = deps.makeOpenspg
    ? deps.makeOpenspg()
    : new OpenSpgClient({
        baseUrl: config.openspg.baseUrl,
        account: config.openspg.account,
        password: config.openspg.password,
      });

  function buildLlm(): AnswerLlm | null {
    const chatCfg = readLlmSetting(db, 'llm.chat', tokenEncKeyB64);
    if (chatCfg === null) return null;
    // Brak llm.embeddings → embed na konfiguracji chatu (jak buildToolLlm w mcp).
    const embedCfg = readLlmSetting(db, 'llm.embeddings', tokenEncKeyB64) ?? chatCfg;
    const chatClient = makeLlmClient(chatCfg);
    const embedClient = embedCfg === chatCfg ? chatClient : makeLlmClient(embedCfg);
    // Breaker jak w buildToolLlm mcp-servera — kokpit widzi realny stan llm.* z ruchu.
    return {
      chat: (req) => withBreaker(db, 'llm.chat', () => chatClient.chat(req)),
      embed: (texts) => withBreaker(db, 'llm.embeddings', () => embedClient.embed(texts)),
    };
  }

  return {
    getLlm(): AnswerLlm | null {
      const fingerprint = llmFingerprint(db);
      if (llmCache !== null && llmCache.fingerprint === fingerprint) return llmCache.value;
      const value = buildLlm();
      llmCache = { fingerprint, value };
      return value;
    },
    getOpenspg(): OpenSpgClient | null {
      return openspg;
    },
    consumeAskLimit(sessionKey: string): void {
      limiter.consume(sessionKey);
    },
  };
}

// ── Namespace'y i walidacja żądania ─────────────────────────────────────────

/** Wszystkie aktywne KB — zbiór dozwolony dla panelu (rejestr = jedyne źródło prawdy). */
export function activeNamespaces(db: Db): string[] {
  return listKbs(db, { status: 'active' }).map((k) => k.namespace);
}

/** Żądane namespaces muszą być podzbiorem aktywnych — inaczej 400 PRZED hijackiem. */
export function assertKnownNamespaces(requested: string[] | undefined, allowed: string[]): void {
  if (requested === undefined || requested.length === 0) return;
  const allowedSet = new Set(allowed);
  const unknown = requested.filter((ns) => !allowedSet.has(ns));
  if (unknown.length > 0) {
    throw new AppError('validation_error', `nieznane lub nieaktywne bazy wiedzy: ${unknown.join(', ')}`, {
      unknown,
      allowed,
    });
  }
}

// ── Historia i feedback ─────────────────────────────────────────────────────

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export interface AskHistoryItem {
  id: string;
  question: string;
  namespaces: string[];
  citations: { n: number; id: string; namespace: string }[];
  confidence: number | null;
  model: string | null;
  degraded: boolean;
  noAnswer: boolean;
  tookMs: number | null;
  createdAt: string;
  feedback: { id: string; verdict: FeedbackVerdict; comment: string | null; createdAt: string }[];
}

/** Ostatnie N odpowiedzi TEGO użytkownika (answers+feedback) — GET /ask/history. */
export function listAskHistory(db: Db, userId: string, limit = 50): AskHistoryItem[] {
  return listAnswersByUser(db, userId, limit).map((row) => ({
    id: row.id,
    question: row.question,
    namespaces: safeParse<string[]>(row.namespaces_json, []),
    citations: safeParse<AskHistoryItem['citations']>(row.citations_json, []),
    confidence: row.confidence,
    model: row.model,
    degraded: row.degraded === 1,
    noAnswer: row.no_answer === 1,
    tookMs: row.took_ms,
    createdAt: row.created_at,
    feedback: row.feedback.map((f) => ({
      id: f.id,
      verdict: f.verdict,
      comment: f.comment,
      createdAt: f.created_at,
    })),
  }));
}

/**
 * Feedback do własnej odpowiedzi: 404 gdy answerId nie istnieje LUB należy do
 * innego użytkownika (bez rozróżniania — nie zdradzamy istnienia cudzych).
 * Kciuk w dół → luka wiedzy automatycznie (repo recordFeedback już to robi).
 */
export function submitAskFeedback(
  db: Db,
  answerId: string,
  userId: string,
  verdict: FeedbackVerdict,
  comment?: string | null,
): RecordFeedbackResult {
  const answer = getAnswer(db, answerId);
  if (answer === null || answer.user_id !== userId) {
    throw new AppError('not_found', `odpowiedź nie istnieje: ${answerId}`);
  }
  // owner także w repo (obrona w głąb — guard nie zniknie przy refaktorze tej funkcji)
  return recordFeedback(db, answerId, verdict, comment ?? null, userId, { userId });
}
