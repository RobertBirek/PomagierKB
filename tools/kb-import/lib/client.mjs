// Klient API panelu z sesją OIDC konta E2E (tools/ux-audit/lib/session.mjs) — żądania wykonywane
// w kontekście strony (page.evaluate → fetch z ciasteczkiem i nagłówkiem Origin, więc CSRF przechodzi).
// Re-login przy 401 (sesja: TTL 12 h, idle 60 min). Throttle mutacji ≤ 50/min (limit serwera 60/min).

import { chromium } from 'playwright';
import { baseUrl, login } from '../../ux-audit/lib/session.mjs';

export class PanelClient {
  constructor({ base = baseUrl(), mutationsPerMinute = 50 } = {}) {
    this.base = base;
    this.browser = null;
    this.page = null;
    this.user = null;
    this.stamps = [];
    this.perMinute = mutationsPerMinute;
  }

  async open() {
    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext({ viewport: { width: 1280, height: 800 } });
    this.page = await context.newPage();
    this.user = await login(this.page, this.base);
    return this;
  }

  async close() {
    await this.browser?.close();
  }

  async throttle() {
    const now = Date.now();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    if (this.stamps.length >= this.perMinute) {
      const wait = 60_000 - (now - this.stamps[0]) + 50;
      await new Promise((r) => setTimeout(r, wait));
      return this.throttle();
    }
    this.stamps.push(Date.now());
  }

  /** Żądanie JSON; zwraca {status, body}. Mutacje (nie-GET) są throttlowane; 401 → re-login raz. */
  async request(method, path, body = null, { retry401 = true, headers = {} } = {}) {
    if (method !== 'GET') await this.throttle();
    const res = await this.page.evaluate(
      async ({ method, path, body, headers }) => {
        const r = await fetch(path, {
          method,
          credentials: 'include',
          headers: { ...(body !== null ? { 'content-type': 'application/json' } : {}), ...headers },
          body: body !== null ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* nie-JSON */
        }
        return { status: r.status, body: json ?? text };
      },
      { method, path, body, headers },
    );
    if (res.status === 401 && retry401) {
      this.user = await login(this.page, this.base);
      return this.request(method, path, body, { retry401: false, headers });
    }
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 15_000));
      return this.request(method, path, body, { retry401, headers });
    }
    return res;
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body, headers) {
    return this.request('POST', path, body ?? {}, { headers });
  }

  patch(path, body) {
    return this.request('PATCH', path, body);
  }

  put(path, body) {
    return this.request('PUT', path, body);
  }

  /** Czeka na koniec akcji (polling GET /actions/:id co 3 s; logTail z DTO → onLog dostaje nowe linie). */
  async waitAction(actionId, { timeoutMs = 130 * 60_000, onLog = null } = {}) {
    const start = Date.now();
    let seen = 0;
    while (Date.now() - start < timeoutMs) {
      const r = await this.get(`/api/v1/actions/${actionId}`);
      if (r.status !== 200) throw new Error(`GET /actions/${actionId} → ${r.status}`);
      const a = r.body.data;
      const tail = Array.isArray(a.logTail) ? a.logTail : String(a.logTail ?? '').split('\n');
      if (onLog && tail.length > seen) {
        onLog(tail.slice(seen));
        seen = tail.length;
      }
      if (a.status !== 'running') return a;
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error(`akcja ${actionId} nie zakończyła się w ${timeoutMs / 60000} min`);
  }
}

/** Pomocnik: rzuca czytelnym błędem, gdy koperta nie jest ok. */
export function expectOk(res, what) {
  if (res.status >= 200 && res.status < 300 && res.body && res.body.ok === true) return res.body.data;
  const err = res.body?.error ? `${res.body.error.code}: ${res.body.error.message ?? ''}` : String(res.body).slice(0, 300);
  throw new Error(`${what} → HTTP ${res.status} ${err}`);
}
