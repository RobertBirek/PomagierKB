import { readFileSync } from 'node:fs';

/** Ładuje fixture JSON z test/fixtures/openspg/. */
export function fixture(name: string): unknown {
  const url = new URL(`../fixtures/openspg/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

export interface RecordedCall {
  url: string;
  path: string;
  init: RequestInit | undefined;
}

export type MockHandler = (path: string, init: RequestInit | undefined, call: RecordedCall) => Response | Promise<Response>;

/** Response JSON 200 (albo z nadpisanym init). */
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Standardowa odpowiedź logowania z DWOMA Set-Cookie (test sklejania). */
export function loginResponse(): Response {
  return new Response(JSON.stringify(fixture('login-ok.json')), {
    status: 200,
    headers: [
      ['content-type', 'application/json'],
      ['set-cookie', 'JSESSIONID=abc123; Path=/; HttpOnly'],
      ['set-cookie', 'OPENSPG_TOKEN=tok456; Path=/'],
    ],
  });
}

/** Mock fetchImpl rejestrujący wywołania; routing w handlerze po ścieżce. */
export function makeMockFetch(handler: MockHandler): { impl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const call: RecordedCall = { url, path, init };
    calls.push(call);
    return handler(path, init, call);
  }) as typeof fetch;
  return { impl, calls };
}

/** Nagłówek z init (init.headers to Headers albo obiekt). */
export function headerOf(call: RecordedCall, name: string): string | null {
  return new Headers(call.init?.headers).get(name);
}
