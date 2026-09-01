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

  check(bucket: string, limit: number, windowMs = 60_000): RateCheck {
    const t = this.now();
    let hits = this.buckets.get(bucket);
    if (hits === undefined) {
      if (this.buckets.size >= MAX_BUCKETS) this.buckets.clear(); // bezpiecznik pamięci
      hits = [];
      this.buckets.set(bucket, hits);
    }
    while (hits.length > 0 && hits[0]! <= t - windowMs) hits.shift();
    if (hits.length >= limit) {
      const oldest = hits[0]!;
      return { ok: false, retryAfter: Math.max(1, Math.ceil((oldest + windowMs - t) / 1000)) };
    }
    hits.push(t);
    return { ok: true, retryAfter: 0 };
  }

  reset(): void {
    this.buckets.clear();
  }
}
