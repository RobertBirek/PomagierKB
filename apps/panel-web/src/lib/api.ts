/**
 * Warstwa HTTP panelu. Kontrakt z panel-api:
 * - koperta {ok:true,data,meta?} / {ok:false,error:{code,message,details?}};
 * - sesja w cookie kag_sid → każdy fetch z credentials:'include';
 * - CSRF przez Origin/Sec-Fetch-Site (same-origin) — nic nie dodajemy w fetch;
 * - 401 → twardy redirect na /auth/login?returnTo=<bieżąca ścieżka>.
 */
import { createSseParser, type SseEvent } from './sse';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  meta?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

function redirectToLogin(): void {
  const returnTo = window.location.pathname + window.location.search;
  window.location.assign('/auth/login?returnTo=' + encodeURIComponent(returnTo));
}

async function parseEnvelope<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError('unauthorized', 'Sesja wygasła', 401);
  }
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = null;
  }
  if (body === null || body.ok !== true) {
    const err = body?.error;
    throw new ApiError(
      err?.code ?? (res.ok ? 'invalid_response' : `http_${res.status}`),
      err?.message ?? `Błąd serwera (HTTP ${res.status})`,
      res.status,
      err?.details,
    );
  }
  return body.data as T;
}

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Obiekt → JSON; FormData → multipart (bez Content-Type ręcznie). */
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Fetch z kopertą. Ścieżki względne od originu ('' — ten sam host co panel),
 * np. apiFetch('/api/v1/me'). Rzuca ApiError; 401 dodatkowo przekierowuje na login.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, headers = {} } = options;
  const init: RequestInit = { method, credentials: 'include', headers };
  if (signal !== undefined) init.signal = signal;
  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json', ...headers };
    }
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('network_error', 'Brak połączenia z serwerem', 0);
  }
  return parseEnvelope<T>(res);
}

export interface ApiSseOptions {
  onEvent: (ev: SseEvent) => void;
  signal?: AbortSignal;
  method?: 'GET' | 'POST';
}

export type { SseEvent };

/**
 * Strumień SSE przez fetch (POST body JSON, np. POST /api/v1/ask).
 * Zdarzenia (event/data) lecą do onEvent; data to surowy string (strony
 * parsują JSON.parse same, bo znają swoje payloady). Przerwanie: AbortSignal.
 * Odpowiedź nie-SSE (błąd w kopercie) → ApiError jak w apiFetch.
 */
export async function apiSse(path: string, body: unknown, options: ApiSseOptions): Promise<void> {
  const { onEvent, signal, method = 'POST' } = options;
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: { Accept: 'text/event-stream' },
  };
  if (signal !== undefined) init.signal = signal;
  if (method === 'POST') {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('network_error', 'Brak połączenia z serwerem', 0);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('text/event-stream')) {
    // Serwer odpowiedział kopertą błędu zamiast strumieniem.
    await parseEnvelope<never>(res);
    throw new ApiError('invalid_response', 'Oczekiwano strumienia SSE', res.status);
  }
  if (res.body === null) throw new ApiError('invalid_response', 'Pusta odpowiedź strumienia', res.status);

  const parser = createSseParser(onEvent);
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail !== '') parser.push(tail);
    parser.end();
  } finally {
    reader.releaseLock();
  }
}
