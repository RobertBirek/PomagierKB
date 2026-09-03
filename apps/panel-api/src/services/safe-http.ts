import { lookup as dnsLookup } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { AppError } from '@pomagierkb/shared/errors';
import {
  allAddressesPublic,
  contentTypeAllowed,
  FETCH_MAX_BYTES,
  FETCH_MAX_REDIRECTS,
  FETCH_TIMEOUT_MS,
  validateFetchUrl,
} from './safe-http-policy.js';

/**
 * safe_http — pobieranie treści z sieci pod ingest URL z twardą ochroną SSRF:
 * - walidacja URL (http/https, port 80/443, bez credentiali) — safe-http-policy,
 * - rozwiązanie DNS i odrzucenie, gdy KTÓRYKOLWIEK adres jest prywatny,
 * - **DNS-pinning**: własny lookup w Agencie undici podaje wyłącznie ZWERYFIKOWANE
 *   adresy — TOCTOU/rebinding (zmiana rekordu między checkiem a połączeniem) nie
 *   przekieruje żądania do sieci wewnętrznej,
 * - redirecty manualne (max 3), każdy hop walidowany od zera end-to-end,
 * - cap 10 MB egzekwowany W TRAKCIE streamu, timeout całości 30 s,
 * - allowlist Content-Type (html/xhtml/plain/markdown/pdf/json).
 * Błędy → AppError z kodami fetch_blocked / fetch_failed / fetch_too_large.
 */

export interface SafeFetchResult {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
}

export interface SafeFetchDeps {
  /** Wstrzykiwane w testach. */
  resolve?: (hostname: string) => Promise<string[]>;
  fetchImpl?: typeof undiciFetch;
  timeoutMs?: number;
  maxBytes?: number;
}

function defaultResolve(hostname: string): Promise<string[]> {
  return new Promise((res, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else res(addresses.map((a) => a.address));
    });
  });
}

/** Agent z lookupem przypiętym do zweryfikowanych adresów (rebinding bez szans). */
function pinnedAgent(pinned: string[]): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, _opts, cb) => {
        const first = pinned[0];
        if (first === undefined) {
          cb(new Error('brak przypiętego adresu'), []);
          return;
        }
        cb(null, [{ address: first, family: first.includes(':') ? 6 : 4 }]);
      },
    },
  });
}

export async function safeFetch(rawUrl: string, deps: SafeFetchDeps = {}): Promise<SafeFetchResult> {
  const resolve = deps.resolve ?? defaultResolve;
  const fetchImpl = deps.fetchImpl ?? undiciFetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? FETCH_MAX_BYTES;
  const deadline = AbortSignal.timeout(timeoutMs);

  let current = rawUrl;
  for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
    const check = validateFetchUrl(current);
    if (!check.ok) throw new AppError('fetch_blocked', `adres odrzucony: ${check.reason}`);
    const url = check.url;

    let ips: string[];
    try {
      ips = await resolve(url.hostname);
    } catch {
      throw new AppError('fetch_failed', `nie można rozwiązać hosta ${url.hostname}`);
    }
    if (!allAddressesPublic(ips)) {
      throw new AppError('fetch_blocked', `host ${url.hostname} wskazuje na adres prywatny/zarezerwowany`);
    }

    const agent = pinnedAgent(ips);
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await fetchImpl(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal: deadline,
        dispatcher: agent,
        headers: {
          'user-agent': 'PomagierKB-ingest/1.0 (+https://kag.ilovelighting.sanok.pl)',
          accept: 'text/html, text/plain, text/markdown, application/pdf, application/json;q=0.9, */*;q=0.1',
        },
      } as Parameters<typeof undiciFetch>[1]);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AppError('fetch_failed', `przekroczono limit czasu ${timeoutMs / 1000} s`);
      }
      throw new AppError('fetch_failed', `połączenie nie powiodło się: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Agent per hop — zamknięcie best-effort (undici domknie sockety po response).
      void agent.close().catch(() => undefined);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc === null) throw new AppError('fetch_failed', `redirect ${res.status} bez Location`);
      if (hop === FETCH_MAX_REDIRECTS) {
        throw new AppError('fetch_blocked', `za dużo przekierowań (>${FETCH_MAX_REDIRECTS})`);
      }
      current = new URL(loc, url).href; // następny hop waliduje się od zera
      continue;
    }
    if (!res.ok) throw new AppError('fetch_failed', `serwer odpowiedział HTTP ${res.status}`);

    const ct = contentTypeAllowed(res.headers.get('content-type'));
    if (!ct.ok) {
      throw new AppError('fetch_blocked', `niedozwolony typ treści '${ct.type || '(brak)'}'`);
    }

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new AppError('fetch_too_large', `treść przekracza limit ${maxBytes} B (Content-Length)`);
    }

    // Stream z twardym capem — abort w połowie ciała, nie po fakcie.
    if (res.body === null) return { buffer: Buffer.alloc(0), contentType: ct.type, finalUrl: url.href };
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new AppError('fetch_too_large', `treść przekracza limit ${maxBytes} B`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return { buffer: Buffer.concat(chunks), contentType: ct.type, finalUrl: url.href };
  }
  throw new AppError('fetch_blocked', 'za dużo przekierowań'); // nieosiągalne
}
