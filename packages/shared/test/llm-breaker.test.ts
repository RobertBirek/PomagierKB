import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations, type Db } from '../src/db/index.js';
import { getBreakerStates, resetBreaker, withBreaker } from '../src/llm/index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const T0 = new Date('2026-01-01T00:00:00.000Z');
const NAME = 'llm.chat';
const opts = { threshold: 3, baseCooldownMs: 60_000, maxCooldownMs: 3_600_000 };

let db: Db;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db = openDb(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

const failing = (): Promise<never> => Promise.reject(new Error('upstream padł'));

function state(name = NAME) {
  const s = getBreakerStates(db).find((b) => b.name === name);
  if (!s) throw new Error('brak wpisu breakera');
  return s;
}

async function openBreaker(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await expect(withBreaker(db, NAME, failing, opts)).rejects.toThrow('upstream padł');
  }
}

function advanceTo(ms: number): void {
  vi.setSystemTime(new Date(T0.getTime() + ms));
}

describe('withBreaker', () => {
  it('3 kolejne porażki otwierają breaker z retry_after = now + baseCooldown', async () => {
    await openBreaker();
    const s = state();
    expect(s.state).toBe('open');
    expect(s.failureCount).toBe(3);
    expect(s.retryAfter).toBe(new Date(T0.getTime() + 60_000).toISOString());
    expect(s.reason).toBe('upstream padł');
  });

  it('sukces zeruje licznik porażek w stanie closed', async () => {
    await expect(withBreaker(db, NAME, failing, opts)).rejects.toThrow();
    await expect(withBreaker(db, NAME, failing, opts)).rejects.toThrow();
    await expect(withBreaker(db, NAME, () => Promise.resolve('ok'), opts)).resolves.toBe('ok');
    expect(state().failureCount).toBe(0);
    // Kolejne 2 porażki NIE otwierają (licznik liczy tylko kolejne porażki).
    await expect(withBreaker(db, NAME, failing, opts)).rejects.toThrow();
    await expect(withBreaker(db, NAME, failing, opts)).rejects.toThrow();
    expect(state().state).toBe('closed');
  });

  it('open przed retry_after odrzuca not_ready BEZ wywołania fn', async () => {
    await openBreaker();
    const fn = vi.fn(() => Promise.resolve('nie powinno się wykonać'));
    advanceTo(59_999);
    await expect(withBreaker(db, NAME, fn, opts)).rejects.toMatchObject({
      code: 'not_ready',
      details: { retryAfter: new Date(T0.getTime() + 60_000).toISOString() },
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('po retry_after half_open przepuszcza jedno wywołanie; sukces zamyka', async () => {
    await openBreaker();
    advanceTo(60_001);
    await expect(withBreaker(db, NAME, () => Promise.resolve('ok'), opts)).resolves.toBe('ok');
    const s = state();
    expect(s.state).toBe('closed');
    expect(s.failureCount).toBe(0);
    expect(s.retryAfter).toBeNull();
  });

  it('porażka sondy half_open otwiera z podwojonym cooldownem (backoff, cap)', async () => {
    await openBreaker();
    advanceTo(60_001);
    await expect(withBreaker(db, NAME, failing, opts)).rejects.toThrow('upstream padł');
    let s = state();
    expect(s.state).toBe('open');
    expect(s.retryAfter).toBe(new Date(T0.getTime() + 60_001 + 120_000).toISOString());

    // Kolejna nieudana sonda → ×2 ponownie.
    advanceTo(60_001 + 120_001);
    await expect(withBreaker(db, NAME, failing, opts)).rejects.toThrow('upstream padł');
    s = state();
    expect(s.state).toBe('open');
    expect(s.retryAfter).toBe(new Date(T0.getTime() + 60_001 + 120_001 + 240_000).toISOString());
  });

  it('cooldown nie przekracza maxCooldownMs', async () => {
    const capped = { threshold: 3, baseCooldownMs: 60_000, maxCooldownMs: 90_000 };
    await openBreaker();
    advanceTo(60_001);
    await expect(withBreaker(db, NAME, failing, capped)).rejects.toThrow('upstream padł');
    expect(state().retryAfter).toBe(new Date(T0.getTime() + 60_001 + 90_000).toISOString());
  });

  it('w trakcie sondy half_open równoległe wywołania są odrzucane', async () => {
    await openBreaker();
    advanceTo(60_001);
    let resolveProbe!: (v: string) => void;
    const probe = withBreaker(db, NAME, () => new Promise<string>((res) => (resolveProbe = res)), opts);
    // Sonda w locie (stan half_open) → drugie wywołanie odbite bez dotykania fn.
    const fn = vi.fn(() => Promise.resolve('drugi'));
    await expect(withBreaker(db, NAME, fn, opts)).rejects.toMatchObject({ code: 'not_ready' });
    expect(fn).not.toHaveBeenCalled();
    resolveProbe('ok');
    await expect(probe).resolves.toBe('ok');
    expect(state().state).toBe('closed');
  });

  it('resetBreaker zamyka natychmiast (przycisk „wznów teraz”)', async () => {
    await openBreaker();
    expect(resetBreaker(db, NAME)).toBe(true);
    const s = state();
    expect(s.state).toBe('closed');
    expect(s.failureCount).toBe(0);
    await expect(withBreaker(db, NAME, () => Promise.resolve('ok'), opts)).resolves.toBe('ok');
  });

  it('resetBreaker zwraca false dla nieznanej nazwy', () => {
    expect(resetBreaker(db, 'nie.istnieje')).toBe(false);
  });
});
