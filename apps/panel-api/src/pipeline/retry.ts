/**
 * withRetry — ponowienia z backoffem i jitterem dla przejściowych awarii usług
 * ekstrakcji (Stirling/Tika). Czysta logika (wstrzykiwane sleep/random — vitest
 * z fake timers). Ponawiamy TYLKO błędy przejściowe: wyjątek sieciowy (fetch
 * rzuca TypeError/AbortError) albo HTTP 429/502/503/504 zgłoszony przez
 * wołającego jako RetryableError; 4xx/parsing NIE są ponawiane.
 */

export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

export const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  /** Wstrzykiwane w testach. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, err: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** true dla błędów wartych ponowienia (sieć/timeout/5xx-przez-RetryableError). */
export function isTransient(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  if (err instanceof Error) {
    // fetch: TypeError (sieć/DNS), AbortError (timeout timedFetch)
    return err.name === 'TypeError' || err.name === 'AbortError';
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(opts.attempts ?? 3, 1);
  const baseMs = opts.baseMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === attempts) throw err;
      opts.onRetry?.(attempt, err);
      const delay = baseMs * 2 ** (attempt - 1) * (0.5 + random());
      await sleep(delay);
    }
  }
  throw lastErr; // nieosiągalne (pętla rzuca), ale TS tego nie wie
}
