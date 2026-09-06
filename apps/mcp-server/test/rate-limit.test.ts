import { describe, expect, it } from 'vitest';
import { RateLimiter, requestCost, toolRateRule } from '../src/rate-limit.js';

describe('RateLimiter', () => {
  it('sliding window: limit egzekwowany, retryAfter > 0, po oknie znów ok', () => {
    let t = 1_000_000;
    const rl = new RateLimiter(() => t);
    expect(rl.check('k', 2).ok).toBe(true);
    expect(rl.check('k', 2).ok).toBe(true);
    const blocked = rl.check('k', 2);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    t += 61_000;
    expect(rl.check('k', 2).ok).toBe(true);
  });

  it('bezpiecznik pamięci NIE zeruje aktywnych okien (ewikcja przeterminowanych)', () => {
    const t = 1_000_000;
    const rl = new RateLimiter(() => t);
    // klucz-ofiara ma AKTYWNE okno (2 hity) — więcej niż jednorazowe buckety spray'a
    rl.check('victim', 2);
    rl.check('victim', 2);
    expect(rl.check('victim', 2).ok).toBe(false);
    // zalew unikalnych bucketów ponad MAX_BUCKETS (10 000)
    for (let i = 0; i < 10_100; i++) rl.check(`spray-${i}`, 60);
    // przed poprawką clear() otwierał ofierze okno; ewikcja wybiera buckety 1-hitowe
    expect(rl.check('victim', 2).ok).toBe(false);
  });

  it('ewikcja usuwa buckety z hitami poza oknem, robiąc miejsce nowym', () => {
    let t = 1_000_000;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 10_000; i++) rl.check(`old-${i}`, 60);
    t += 120_000; // wszystkie stare okna przeterminowane
    expect(rl.check('fresh', 1).ok).toBe(true);
    expect(rl.check('fresh', 1).ok).toBe(false);
  });

  it('cost>1 rezerwuje atomowo: brak miejsca = nic nie skonsumowane', () => {
    const t = 1_000_000;
    const rl = new RateLimiter(() => t);
    expect(rl.check('k', 10, 60_000, 4).ok).toBe(true); // 4/10
    const tooBig = rl.check('k', 10, 60_000, 7); // 4+7 > 10
    expect(tooBig.ok).toBe(false);
    expect(tooBig.retryAfter).toBeGreaterThan(0);
    expect(rl.check('k', 10, 60_000, 6).ok).toBe(true); // odbicie nic nie zjadło → 10/10
    expect(rl.check('k', 10).ok).toBe(false);
  });

  it('cost większy niż cały limit → odmowa z retryAfter = pełne okno', () => {
    const t = 1_000_000;
    const rl = new RateLimiter(() => t);
    const res = rl.check('k', 10, 60_000, 11);
    expect(res.ok).toBe(false);
    expect(res.retryAfter).toBe(60);
  });
});

describe('requestCost — batch JSON-RPC liczony per wiadomość', () => {
  it('pojedyncza wiadomość = 1, tablica N = N, pusta tablica = 1', () => {
    expect(requestCost({ jsonrpc: '2.0', method: 'tools/list' })).toBe(1);
    expect(requestCost([1, 2, 3])).toBe(3);
    expect(requestCost([])).toBe(1);
    expect(requestCost(undefined)).toBe(1);
  });
});

describe('toolRateRule — limity narzędziowe wg kosztu zewnętrznego', () => {
  it('kb_answer i kb_claim_verify: 10/min', () => {
    expect(toolRateRule('kb_answer', {})).toEqual({ bucket: 'answer', limit: 10 });
    expect(toolRateRule('kb_claim_verify', {})).toEqual({ bucket: 'claim_verify', limit: 10 });
  });

  it('kb_search: hybrid (także domyślny brak mode) i vector → 30/min, text → bez limitu', () => {
    expect(toolRateRule('kb_search', {})).toEqual({ bucket: 'vector_search', limit: 30 });
    expect(toolRateRule('kb_search', { mode: 'hybrid' })?.limit).toBe(30);
    expect(toolRateRule('kb_search', { mode: 'vector' })?.limit).toBe(30);
    expect(toolRateRule('kb_search', { mode: 'text' })).toBeNull();
  });

  it('narzędzia bez kosztu zewnętrznego nie mają limitu narzędziowego', () => {
    expect(toolRateRule('kb_list', {})).toBeNull();
    expect(toolRateRule('kb_feedback', {})).toBeNull();
  });
});
