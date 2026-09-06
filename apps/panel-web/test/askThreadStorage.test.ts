/**
 * D13-03: adapter sessionStorage wątku /ask. Sprawdzamy izolację między
 * tożsamościami i to, że wylogowanie faktycznie usuwa klucz z karty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASK_THREAD_STORAGE_KEY, type ThreadEntry } from '../src/lib/askThread';
import { clearThread, readThread, writeThread } from '../src/lib/askThreadStorage';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    has: (k: string) => map.has(k),
    raw: (k: string) => map.get(k) ?? null,
  };
}

let store: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  store = fakeStorage();
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = store;
});

afterEach(() => {
  delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
});

const entry: ThreadEntry = {
  key: 1,
  question: 'Ile kosztuje przegląd?',
  result: {
    answer: 'Poufna odpowiedź z bazy',
    citations: [{ n: 1, id: 'c1', namespace: 'kb_a', snippet: 'fragment dokumentu' }],
    confidence: 0.9,
    model: 'm',
    degraded: false,
    gapRecorded: false,
    noAnswer: false,
    answerId: 'a1',
    warnings: [],
  },
  error: null,
  stopped: false,
  verdict: null,
};

describe('readThread() / writeThread()', () => {
  it('ten sam użytkownik odzyskuje wątek, inny dostaje pusty', () => {
    writeThread([entry], 'user-1');
    expect(readThread('user-1')).toHaveLength(1);
    expect(readThread('user-2')).toEqual([]);
    expect(readThread(null)).toEqual([]);
  });

  it('bez znanej tożsamości nic nie utrwalamy (i kasujemy zastane)', () => {
    writeThread([entry], 'user-1');
    writeThread([entry], null);
    expect(store.has(ASK_THREAD_STORAGE_KEY)).toBe(false);
  });

  it('nadpisanie wątkiem nowego właściciela usuwa treść poprzednika', () => {
    writeThread([entry], 'user-1');
    writeThread([], 'user-2');
    expect(store.raw(ASK_THREAD_STORAGE_KEY)).not.toContain('Poufna odpowiedź');
  });

  it('clearThread() usuwa klucz (ścieżka wylogowania)', () => {
    writeThread([entry], 'user-1');
    clearThread();
    expect(store.has(ASK_THREAD_STORAGE_KEY)).toBe(false);
    expect(readThread('user-1')).toEqual([]);
  });

  it('brak sessionStorage (prywatny tryb) nie wysypuje strony', () => {
    delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
    expect(() => writeThread([entry], 'user-1')).not.toThrow();
    expect(() => clearThread()).not.toThrow();
    expect(readThread('user-1')).toEqual([]);
  });
});
