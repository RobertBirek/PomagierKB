/**
 * Rate limit per klucz w pamięci (sliding window): 60 req/min na klucz,
 * kb_answer 10/min (koszt LLM). Przekroczenie → JSON-RPC error z retryAfter.
 */

export interface RateCheck {
  ok: boolean;
  /** Sekundy do zwolnienia okna (0 gdy ok). */
  retryAfter: number;
}

const MAX_BUCKETS = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * `cost` = ile jednostek pochłania żądanie (batch JSON-RPC: N wiadomości = N
   * jednostek). Rezerwacja jest atomowa: jeśli cały koszt się nie mieści, NIC nie
   * jest zapisywane i wołający dostaje 429 — inaczej batch konsumowałby okno
   * częściowo, a i tak zostałby wykonany w całości.
   */
  check(bucket: string, limit: number, windowMs = 60_000, cost = 1): RateCheck {
    const t = this.now();
    let hits = this.buckets.get(bucket);
    if (hits === undefined) {
      if (this.buckets.size >= MAX_BUCKETS) this.evict(t, windowMs);
      hits = [];
      this.buckets.set(bucket, hits);
    }
    while (hits.length > 0 && hits[0]! <= t - windowMs) hits.shift();
    if (hits.length + cost > limit) {
      const oldest = hits[0];
      // cost > limit: żądanie nie zmieści się nigdy — retryAfter = pełne okno
      return {
        ok: false,
        retryAfter:
          oldest === undefined
            ? Math.max(1, Math.ceil(windowMs / 1000))
            : Math.max(1, Math.ceil((oldest + windowMs - t) / 1000)),
      };
    }
    for (let i = 0; i < cost; i++) hits.push(t);
    return { ok: true, retryAfter: 0 };
  }

  /**
   * Bezpiecznik pamięci BEZ kasowania aktywnych okien: najpierw wypadają buckety
   * przeterminowane (ostatni hit poza oknem), a gdy to nie starczy — najstarsze.
   * `clear()` było tu podatnością: zalew unikalnych kluczy zerował limity wszystkim.
   */
  private evict(t: number, windowMs: number): void {
    for (const [key, hits] of this.buckets) {
      const last = hits[hits.length - 1];
      if (last === undefined || last <= t - windowMs) this.buckets.delete(key);
    }
    if (this.buckets.size < MAX_BUCKETS) return;
    // Nic przeterminowanego: wypada bucket o najmniejszej aktywności (najmniej hitów,
    // tiebreak: najstarszy hit) — jednorazowe buckety spray'a giną przed aktywnymi oknami.
    let victimKey: string | null = null;
    let victimHits = Infinity;
    let victimLast = Infinity;
    for (const [key, hits] of this.buckets) {
      const last = hits[hits.length - 1] ?? 0;
      if (hits.length < victimHits || (hits.length === victimHits && last < victimLast)) {
        victimHits = hits.length;
        victimLast = last;
        victimKey = key;
      }
    }
    if (victimKey !== null) this.buckets.delete(victimKey);
  }

  reset(): void {
    this.buckets.clear();
  }
}

// ── Czysta logika limitów (bez frameworka; testy vitest) ────────────────────

/** Limit globalny per klucz (jednostka = wiadomość JSON-RPC, nie żądanie HTTP). */
export const RATE_LIMIT_PER_MIN = 60;

/**
 * Limity narzędziowe — narzędzia o realnym koszcie zewnętrznym (LLM/OpenSPG)
 * dostają własne, ciaśniejsze okno ponad limitem globalnym.
 */
export const TOOL_RATE_LIMITS = {
  /** kb_answer: chat LLM na każdą odpowiedź. */
  answer: 10,
  /** kb_claim_verify: chat LLM na każdą weryfikację twierdzenia. */
  claim_verify: 10,
  /** kb_search w trybie vector/hybrid: embedding LLM + 2 zapytania OpenSPG. */
  vector_search: 30,
} as const;

export interface ToolRateRule {
  /** Prefiks bucketu (pełny bucket: `<bucket>:<keyId>`). */
  bucket: string;
  limit: number;
}

/**
 * Reguła limitu narzędziowego dla (nazwa narzędzia, wejście). null = brak limitu
 * narzędziowego (obowiązuje tylko limit globalny per klucz).
 * kb_search: tryb domyślny to 'hybrid' (patrz kb-search.ts), więc brak pola `mode`
 * oznacza ścieżkę wektorową i podlega limitowi.
 */
export function toolRateRule(toolName: string, input: unknown): ToolRateRule | null {
  if (toolName === 'kb_answer') return { bucket: 'answer', limit: TOOL_RATE_LIMITS.answer };
  if (toolName === 'kb_claim_verify') {
    return { bucket: 'claim_verify', limit: TOOL_RATE_LIMITS.claim_verify };
  }
  if (toolName === 'kb_search') {
    const mode =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)['mode']
        : undefined;
    if (mode === undefined || mode === 'hybrid' || mode === 'vector') {
      return { bucket: 'vector_search', limit: TOOL_RATE_LIMITS.vector_search };
    }
  }
  return null;
}

/**
 * Koszt żądania HTTP w jednostkach limitera. Transport 2025 (SDK v1) wykonuje
 * KAŻDĄ wiadomość tablicy JSON-RPC, więc batch o długości N to N wywołań — bez
 * tego batch omijał limit 60/min N-krotnie (jeden hit na cały POST).
 */
export function requestCost(body: unknown): number {
  return Array.isArray(body) ? Math.max(1, body.length) : 1;
}
