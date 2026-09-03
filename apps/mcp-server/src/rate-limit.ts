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
      if (this.buckets.size >= MAX_BUCKETS) this.evict(t, windowMs);
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
