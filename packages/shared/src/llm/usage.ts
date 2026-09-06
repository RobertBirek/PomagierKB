import type { Db } from '../db/open.js';
import { nowIso } from '../db/open.js';

/**
 * Trwały rejestr zużycia tokenów LLM (ustalenie GAP-05: koszt był NIEMIERZALNY —
 * tokeny szły wyłącznie do logu pino rotowanego przez dockera, a answers.model
 * było NULL we wszystkich wierszach produkcyjnych).
 *
 * Zapis: jeden wiersz llm_usage na wywołanie z usage od providera. Punkt wpięcia
 * to `withBreaker` (packages/shared/src/llm/breaker.ts) — JEDYNE miejsce, przez
 * które przechodzą wszystkie wywołania LLM w systemie — oraz opcjonalny callback
 * `onUsage` klienta (embeddings nie mają kanału w typie wyniku).
 * Odczyt: aggregateLlmUsage — sumy per model/cel/baza w oknie czasu; koszt liczy
 * konsument (stawki z settings, NIE z kodu).
 */

export interface LlmUsageEvent {
  endpoint: 'chat' | 'embeddings';
  /** Cel/wołający: nazwa breakera ('llm.chat') albo etykieta pipeline'u. */
  purpose: string;
  model: string;
  /** Baza wiedzy, jeśli znana w miejscu wywołania (atrybucja kosztu per KB). */
  namespace?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** Nadpisanie znacznika czasu (testy). */
  at?: string;
}

/** Liczba całkowita ≥ 0 albo 0 — provider bywa oszczędny w polach usage. */
function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Dopisuje wiersz zużycia. NIGDY nie rzuca — telemetria nie może wywrócić
 * ścieżki odpowiedzi (brak tabeli w starszej bazie, blokada zapisu itp.).
 */
export function recordLlmUsage(db: Db, event: LlmUsageEvent): void {
  try {
    db.prepare(
      `INSERT INTO llm_usage (at, endpoint, purpose, model, namespace, prompt_tokens, completion_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.at ?? nowIso(),
      event.endpoint,
      event.purpose,
      event.model,
      event.namespace ?? null,
      nonNegInt(event.promptTokens),
      nonNegInt(event.completionTokens),
    );
  } catch {
    /* best-effort: rejestr kosztu nie może zablokować odpowiedzi */
  }
}

export interface LlmUsageBucket {
  key: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmUsageAggregate {
  sinceIso: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byModel: LlmUsageBucket[];
  byPurpose: LlmUsageBucket[];
  byNamespace: LlmUsageBucket[];
}

interface BucketRow {
  key: string | null;
  calls: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

function buckets(db: Db, column: string, sinceIso: string): LlmUsageBucket[] {
  // `column` pochodzi WYŁĄCZNIE z literałów poniżej (nigdy z wejścia użytkownika).
  const rows = db
    .prepare(
      `SELECT ${column} AS key, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens
         FROM llm_usage WHERE at >= ? GROUP BY ${column} ORDER BY SUM(prompt_tokens + completion_tokens) DESC`,
    )
    .all(sinceIso) as BucketRow[];
  return rows.map((r) => {
    const prompt = r.prompt_tokens ?? 0;
    const completion = r.completion_tokens ?? 0;
    return {
      key: r.key ?? '(brak)',
      calls: r.calls,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
    };
  });
}

/** Agregat zużycia od `sinceIso`: sumy globalne + rozbicia per model/cel/baza. */
export function aggregateLlmUsage(db: Db, sinceIso: string): LlmUsageAggregate {
  const empty: LlmUsageAggregate = {
    sinceIso,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    byModel: [],
    byPurpose: [],
    byNamespace: [],
  };
  try {
    const byModel = buckets(db, 'model', sinceIso);
    const total = byModel.reduce(
      (acc, b) => ({
        calls: acc.calls + b.calls,
        promptTokens: acc.promptTokens + b.promptTokens,
        completionTokens: acc.completionTokens + b.completionTokens,
      }),
      { calls: 0, promptTokens: 0, completionTokens: 0 },
    );
    return {
      sinceIso,
      ...total,
      totalTokens: total.promptTokens + total.completionTokens,
      byModel,
      byPurpose: buckets(db, 'purpose', sinceIso),
      byNamespace: buckets(db, 'namespace', sinceIso),
    };
  } catch {
    // Starsza baza bez tabeli llm_usage → pusty agregat zamiast wywrócenia raportu.
    return empty;
  }
}

/** Kształt wyniku niosącego usage (ChatResult) — sniff bez zależności od typu. */
interface UsageCarrier {
  model?: unknown;
  usage?: { promptTokens?: unknown; completionTokens?: unknown } | undefined;
  usageReported?: unknown;
}

/**
 * Zapisuje zużycie z wyniku wywołania LLM, jeśli wynik je niesie i nie zostało
 * już zaraportowane przez callback `onUsage` klienta (bez podwójnego liczenia).
 * Wywoływane z withBreaker dla nazw 'llm.*'.
 */
export function recordUsageFromResult(db: Db, purpose: string, result: unknown): void {
  if (result === null || typeof result !== 'object') return;
  const carrier = result as UsageCarrier;
  if (carrier.usageReported === true) return;
  const usage = carrier.usage;
  if (usage === null || typeof usage !== 'object') return;
  const promptTokens = typeof usage.promptTokens === 'number' ? usage.promptTokens : null;
  const completionTokens = typeof usage.completionTokens === 'number' ? usage.completionTokens : null;
  if (promptTokens === null && completionTokens === null) return;
  recordLlmUsage(db, {
    endpoint: 'chat',
    purpose,
    model: typeof carrier.model === 'string' && carrier.model !== '' ? carrier.model : '(nieznany)',
    promptTokens,
    completionTokens,
  });
}
