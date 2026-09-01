import { createHash } from 'node:crypto';
import { UpstreamError } from '../errors.js';

export interface OpenSpgClientOptions {
  baseUrl: string;
  account: string;
  password: string;
  /** Podmienialny fetch (testy); domyślnie globalny fetch Node 22. */
  fetchImpl?: typeof fetch;
  /** Timeout pojedynczego żądania HTTP (ms), domyślnie 30 s. */
  timeoutMs?: number;
}

/** Komunikaty {success:false} wskazujące na wygaśniętą/nieobecną sesję produktową. */
const SESSION_MSG_RE = /log[- ]?in|logged|session|auth|token|expired|登录/i;

function extractMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const msg = o['resultMsg'] ?? o['errorMsg'] ?? o['message'];
    if (typeof msg === 'string') return msg;
  }
  return '';
}

/**
 * Klient REST OpenSPG 0.8: cookie sesyjne w pamięci, auto-login i JEDNO ponowienie
 * przy 401/403 lub {success:false} z komunikatem sesyjnym. Błędy transportu/HTTP
 * mapowane na UpstreamError. Nigdy nie loguje cookie ani hasła.
 */
export class OpenSpgClient {
  private readonly baseUrl: string;
  private readonly account: string;
  private readonly password: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cookie: string | null = null;

  constructor(opts: OpenSpgClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.account = opts.account;
    this.password = opts.password;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Fetch z timeoutem (AbortSignal); withCookie dokleja aktualne cookie sesji. */
  private async doFetch(path: string, init: RequestInit, withCookie: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    if (withCookie && this.cookie !== null) headers.set('cookie', this.cookie);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.baseUrl + path, { ...init, headers, signal: controller.signal });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : (err as Error).message;
      throw new UpstreamError('openspg', path, undefined, `OpenSPG fetch failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private static async parseBody(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  /** Login produktowy: hasło sha256(password+'OPENSPG'), sklejenie WSZYSTKICH Set-Cookie. */
  async login(): Promise<void> {
    const path = '/v1/accounts/login';
    const hashed = createHash('sha256').update(this.password + 'OPENSPG').digest('hex');
    const res = await this.doFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: this.account, password: hashed }),
    }, false);
    const body = await OpenSpgClient.parseBody(res);
    if (!res.ok) throw new UpstreamError('openspg', path, res.status, 'OpenSPG login failed');
    if (body && typeof body === 'object' && (body as Record<string, unknown>)['success'] === false) {
      throw new UpstreamError('openspg', path, res.status, extractMessage(body) || 'OpenSPG login rejected');
    }
    const setCookies = res.headers.getSetCookie();
    if (setCookies.length === 0) {
      throw new UpstreamError('openspg', path, res.status, 'OpenSPG login: brak Set-Cookie w odpowiedzi');
    }
    // 'a=b; Path=/; HttpOnly' → 'a=b'; wszystkie ciastka sklejone w jeden nagłówek Cookie
    this.cookie = setCookies.map((c) => (c.split(';')[0] ?? '').trim()).filter((c) => c !== '').join('; ');
  }

  /** Czy odpowiedź wymaga ponownego logowania (wygasła sesja). */
  private static needsRelogin(res: Response, body: unknown): boolean {
    if (res.status === 401 || res.status === 403) return true;
    if (body && typeof body === 'object' && (body as Record<string, unknown>)['success'] === false) {
      return SESSION_MSG_RE.test(extractMessage(body));
    }
    return false;
  }

  /**
   * Żądanie z automatycznym loginem (lazy) i JEDNYM ponowieniem po utracie sesji.
   * Zwraca sparsowane body (JSON lub surowy tekst); HTTP !ok → UpstreamError.
   */
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (this.cookie === null) await this.login();
    let res = await this.doFetch(path, init, true);
    let body = await OpenSpgClient.parseBody(res);
    if (OpenSpgClient.needsRelogin(res, body)) {
      this.cookie = null;
      await this.login();
      res = await this.doFetch(path, init, true);
      body = await OpenSpgClient.parseBody(res);
    }
    if (!res.ok) {
      throw new UpstreamError('openspg', path, res.status, `OpenSPG HTTP ${res.status}: ${extractMessage(body) || 'błąd upstreamu'}`);
    }
    return body;
  }

  /** request() + rozpakowanie koperty {success,result}; success:false → UpstreamError. */
  async requestResult(path: string, init: RequestInit = {}): Promise<unknown> {
    const body = await this.request(path, init);
    if (body && typeof body === 'object' && !Array.isArray(body) && 'success' in body) {
      const o = body as Record<string, unknown>;
      if (o['success'] === false) {
        throw new UpstreamError('openspg', path, undefined, extractMessage(body) || 'OpenSPG success=false');
      }
      return o['result'];
    }
    return body;
  }

  /** Skrót: POST JSON. */
  async postJson(path: string, payload: unknown): Promise<unknown> {
    return this.requestResult(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}
