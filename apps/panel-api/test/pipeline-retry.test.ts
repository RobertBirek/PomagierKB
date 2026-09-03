import { describe, expect, it } from 'vitest';
import { isTransient, RetryableError, withRetry } from '../src/pipeline/retry.js';

/** Testy withRetry — czysta logika z wstrzykiwanym sleep (bez realnego czekania). */

const noSleep = async (): Promise<void> => undefined;

describe('withRetry', () => {
  it('przejściowy błąd → ponowienie i sukces; delaye rosną wykładniczo', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new RetryableError(`HTTP 502 (próba ${calls})`);
        return 'ok';
      },
      { attempts: 3, baseMs: 100, sleep: async (ms) => { delays.push(ms); }, random: () => 0.5 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]); // base*2^0*1.0, base*2^1*1.0 (random=0.5 → mnożnik 1)
  });

  it('błąd nie-przejściowy NIE jest ponawiany', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('HTTP 400 — złe żądanie');
        },
        { attempts: 3, sleep: noSleep },
      ),
    ).rejects.toThrow('400');
    expect(calls).toBe(1);
  });

  it('wyczerpane próby → ostatni błąd propagowany', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new RetryableError('HTTP 503');
        },
        { attempts: 3, sleep: noSleep },
      ),
    ).rejects.toThrow('503');
    expect(calls).toBe(3);
  });

  it('isTransient: RetryableError/TypeError/AbortError tak, zwykły Error nie', () => {
    expect(isTransient(new RetryableError('x'))).toBe(true);
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    const abort = new Error('timeout');
    abort.name = 'AbortError';
    expect(isTransient(abort)).toBe(true);
    expect(isTransient(new Error('parse error'))).toBe(false);
    expect(isTransient('string')).toBe(false);
  });
});
