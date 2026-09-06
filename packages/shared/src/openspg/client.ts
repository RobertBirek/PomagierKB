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
  /**
   * Sygnał anulowania obejmujący WSZYSTKIE żądania tego klienta (D8-10). Ustawia
   * go withSignal(); wołający, który nakłada własny, krótszy deadline (np. 5 s
   * timeoutu kanału retrievalu), musi mieć jak realnie przerwać żądanie —
   * inaczej połączenie żyje dalej z 30-sekundowym timeoutem klienta i breaker
   * otwiera się dopiero po ~3×30 s zamiast po 3×5 s.
   */
  signal?: AbortSignal;
}

/** Sesja produktowa (cookie) współdzielona przez klienta i jego warianty z sygnałem. */
interface SessionState {
  cookie: string | null;
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
  private readonly opts: OpenSpgClientOptions;
  /** Sesja w obiekcie (nie w polu) — warianty z withSignal dzielą to samo cookie. */
  private session: SessionState = { cookie: null };
  private readonly signal: AbortSignal | undefined;

  constructor(opts: OpenSpgClientOptions) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.account = opts.account;
    this.password = opts.password;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.signal = opts.signal;
  }

  /**
   * Wariant klienta anulowany przez `signal`, WSPÓŁDZIELĄCY sesję (cookie) —
   * ponowne logowanie w wariancie widzi też oryginał i odwrotnie. Do przekazania
   * kodowi, który przyjmuje `OpenSpgClient` (search.ts) bez zmiany jego API.
   */
  withSignal(signal: AbortSignal): OpenSpgClient {
    const scoped = new OpenSpgClient({ ...this.opts, signal });
    scoped.session = this.session; // ta sama sesja produktowa
    return scoped;
  }

  /**
   * Łączy sygnał timeoutu klienta z sygnałem wołającego (init.signal / withSignal).
   * `AbortSignal.any` jest w Node 20+; brak wsparcia → sam timeout (degradacja
   * do stanu sprzed poprawki, nigdy wyjątek).
   */
  private combineSignals(timeout: AbortSignal, external: AbortSignal | undefined): AbortSignal {
    if (external === undefined) return timeout;
    const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
    return typeof any === 'function' ? any([timeout, external]) : timeout;
  }

  /** Fetch z timeoutem (AbortSignal); withCookie dokleja aktualne cookie sesji. */
  private async doFetch(path: string, init: RequestInit, withCookie: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    if (withCookie && this.session.cookie !== null) headers.set('cookie', this.session.cookie);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Kolejność ważna: sygnał wołającego z `init` ma pierwszeństwo nad instancyjnym.
    const external = (init.signal ?? undefined) ?? this.signal;
    try {
      return await this.fetchImpl(this.baseUrl + path, {
        ...init,
        headers,
        signal: this.combineSignals(controller.signal, external),
      });
    } catch (err) {
      // Rozróżnienie w komunikacie: własny timeout klienta vs anulowanie przez
      // wołającego (deadline kanału) — inaczej diagnoza jest nie do zrobienia.
      const aborted = err instanceof Error && err.name === 'AbortError';
      const reason = aborted
        ? external?.aborted === true && !controller.signal.aborted
          ? 'anulowane przez wołającego'
          : 'timeout'
        : (err as Error).message;
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
    this.session.cookie = setCookies
      .map((c) => (c.split(';')[0] ?? '').trim())
      .filter((c) => c !== '')
      .join('; ');
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
   * `init.signal` (albo sygnał z withSignal) anuluje realne połączenie — także
   * login i ponowienie, więc anulowany kanał nie zostawia żadnego żądania w locie.
   */
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (this.session.cookie === null) await this.login();
    let res = await this.doFetch(path, init, true);
    let body = await OpenSpgClient.parseBody(res);
    if (OpenSpgClient.needsRelogin(res, body)) {
      this.session.cookie = null;
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
