import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';

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
});
