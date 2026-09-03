import { describe, expect, it } from 'vitest';
import { AppError } from '@pomagierkb/shared/errors';
import { safeFetch, type SafeFetchDeps } from '../src/services/safe-http.js';

/** safeFetch z wstrzykniętym resolve/fetch — bez sieci. */

function fakeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}): Response {
  const body = opts.body === undefined ? null : typeof opts.body === 'string' ? opts.body : opts.body;
  return new Response(body, { status: opts.status ?? 200, headers: opts.headers ?? {} });
}

function deps(over: Partial<SafeFetchDeps> & { responses?: Response[] }): SafeFetchDeps {
  const queue = over.responses ?? [];
  return {
    resolve: over.resolve ?? (async () => ['93.184.216.34']),
    fetchImpl: (over.fetchImpl ??
      (async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error('brak zaplanowanej odpowiedzi');
        return next;
      })) as SafeFetchDeps['fetchImpl'],
    timeoutMs: 5000,
    maxBytes: over.maxBytes ?? 1024,
  };
}

describe('safeFetch', () => {
  it('pobiera dozwolony content i zwraca finalny URL', async () => {
    const res = await safeFetch('https://example.com/doc', deps({
      responses: [fakeResponse({ headers: { 'content-type': 'text/plain' }, body: 'treść dokumentu' })],
    }));
    expect(res.buffer.toString('utf8')).toBe('treść dokumentu');
    expect(res.contentType).toBe('text/plain');
    expect(res.finalUrl).toBe('https://example.com/doc');
  });

  it('host rozwiązujący się na prywatny adres → fetch_blocked (nawet częściowo)', async () => {
    await expect(
      safeFetch('https://evil.example/x', deps({ resolve: async () => ['8.8.8.8', '10.0.0.1'] })),
    ).rejects.toMatchObject({ code: 'fetch_blocked' });
  });

  it('redirect walidowany od zera: hop na prywatny host → fetch_blocked', async () => {
    const resolves: Record<string, string[]> = {
      'public.example': ['93.184.216.34'],
      'internal.example': ['192.168.0.10'],
    };
    await expect(
      safeFetch('https://public.example/a', deps({
        resolve: async (h) => resolves[h] ?? [],
        responses: [fakeResponse({ status: 302, headers: { location: 'https://internal.example/admin' } })],
      })),
    ).rejects.toMatchObject({ code: 'fetch_blocked' });
  });

  it('za dużo redirectów → fetch_blocked', async () => {
    const redirect = (): Response =>
      fakeResponse({ status: 301, headers: { location: 'https://example.com/next' } });
    await expect(
      safeFetch('https://example.com/a', deps({ responses: [redirect(), redirect(), redirect(), redirect()] })),
    ).rejects.toMatchObject({ code: 'fetch_blocked' });
  });

  it('niedozwolony content-type → fetch_blocked; HTTP 500 → fetch_failed', async () => {
    await expect(
      safeFetch('https://example.com/bin', deps({
        responses: [fakeResponse({ headers: { 'content-type': 'application/zip' }, body: 'x' })],
      })),
    ).rejects.toMatchObject({ code: 'fetch_blocked' });
    await expect(
      safeFetch('https://example.com/err', deps({ responses: [fakeResponse({ status: 500 })] })),
    ).rejects.toMatchObject({ code: 'fetch_failed' });
  });

  it('cap rozmiaru egzekwowany w streamie → fetch_too_large', async () => {
    const big = new Uint8Array(4096).fill(65);
    await expect(
      safeFetch('https://example.com/big', deps({
        maxBytes: 1024,
        responses: [fakeResponse({ headers: { 'content-type': 'text/plain' }, body: big })],
      })),
    ).rejects.toMatchObject({ code: 'fetch_too_large' });
  });

  it('błędne wejście (protokół/port) odrzucane zanim poleci DNS', async () => {
    let resolved = 0;
    const d = deps({ resolve: async () => { resolved++; return ['8.8.8.8']; } });
    await expect(safeFetch('ftp://example.com/x', d)).rejects.toMatchObject({ code: 'fetch_blocked' });
    await expect(safeFetch('https://example.com:8887/x', d)).rejects.toMatchObject({ code: 'fetch_blocked' });
    expect(resolved).toBe(0);
  });

  it('AppError niesie kod znany kopercie błędów', () => {
    const e = new AppError('fetch_blocked', 'x');
    expect(e.statusCode).toBe(422);
  });
});
