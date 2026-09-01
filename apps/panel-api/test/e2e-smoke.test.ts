import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { getSetting, openDb, runMigrations, type Db } from '@pomagierkb/shared/db';
import { buildApp } from '../src/app.js';
import { makeTestConfig } from '../src/config.js';
import { sharedMigrationsDir } from '../src/lib/migrations.js';
import { startAction } from '../src/services/actions-runner.js';
import { startMockOidc, performLogin, type MockOidc } from './helpers/oidc-mock.js';

/**
 * SMOKE E2E całego panelu-api w JEDNEJ instancji aplikacji (inject + realny
 * listen dla SSE): healthz → pełny login OIDC (mock IdP) → utworzenie KB →
 * akcja noop (prawdziwy spawn dziecka, polling + SSE) → sekret w settings
 * (sealed, maskowany) → klucz MCP (raw dokładnie raz). Do tego przekroje:
 * koperta {ok,data}/{ok:false,error}, 405+Allow, RBAC deny-by-default.
 */

const panelApiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const jobEntry = join(panelApiDir, 'dist', 'jobs', 'run-job.js');

let mock: MockOidc;
let app: FastifyInstance;
let db: Db;
let dataDir: string;
let baseUrl: string;
let sid = ''; // sesja admina z pełnego logowania OIDC — współdzielona przez kroki

function cookieHeader(): Record<string, string> {
  return { cookie: `kag_sid=${sid}` };
}

function parseSse(text: string): { event: string; data: unknown }[] {
  const events: { event: string; data: unknown }[] = [];
  for (const block of text.split('\n\n')) {
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (eventLine === undefined || dataLine === undefined) continue; // heartbeat/komentarz
    events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
  }
  return events;
}

async function readSseUntilEnd(url: string, timeoutMs = 8_000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: cookieHeader(), signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    let text = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      text += Buffer.from(chunk).toString('utf8');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  // Joby jak w produkcji: skompilowane dziecko node dist/jobs/run-job.js.
  execSync(
    'npx tsc src/jobs/job-types.ts src/jobs/noop.ts src/jobs/run-job.ts ' +
      '--outDir dist/jobs --module nodenext --moduleResolution nodenext ' +
      '--target es2023 --skipLibCheck --noCheck',
    { cwd: panelApiDir, stdio: 'pipe' },
  );
  expect(existsSync(jobEntry)).toBe(true);

  mock = await startMockOidc();
  // Plik DB (nie :memory:) — proces potomny akcji otwiera ten sam plik SQLite.
  dataDir = mkdtempSync(join(tmpdir(), 'pomagierkb-smoke-'));
  db = openDb(join(dataDir, 'db', 'kag.db'));
  runMigrations(db, sharedMigrationsDir());
  app = await buildApp({
    config: makeTestConfig({
      dataDir,
      oidc: { issuer: mock.issuer, clientId: 'kag-panel', clientSecret: 'test-client-secret' },
      rateLimits: { global: 10_000, auth: 1_000, mutation: 1_000 },
    }),
    db,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('brak adresu nasłuchu');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await app.close();
  db.close();
  await mock.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('smoke E2E: pełny przepływ panelu', () => {
  it('1. /healthz odpowiada 200 {ok:true} bez sesji', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('2. deny-by-default: /api/v1/kbs bez sesji → 401 w kopercie błędu', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/kbs' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { ok: boolean; error: { code: string; requestId?: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unauthorized');
  });

  it('3. pełny login OIDC przez mock IdP → sesja admina, /me', async () => {
    mock.state.groups = ['kag-admin'];
    const { cbRes, sid: gotSid } = await performLogin(app, mock, { returnTo: '/panel' });
    expect(cbRes.statusCode).toBe(302);
    expect(gotSid).not.toBe('');
    sid = gotSid;

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { kag_sid: sid } });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { ok: boolean; data: { user: { role: string; id: string } } };
    expect(body.data.user.role).toBe('admin');
  });

  it('4. POST /kbs tworzy wpis rejestru (201), widoczny w GET /kbs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/kbs',
      cookies: { kag_sid: sid },
      payload: {
        namespace: 'SmokeKb',
        name: 'Baza smoke',
        documentTypes: [{ name: 'Instrukcja' }],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { ok: boolean; data: { kb: { namespace: string } } };
    expect(created.ok).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/v1/kbs', cookies: { kag_sid: sid } });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { data: { items: { namespace: string }[] } }).data.items;
    expect(items.map((i) => i.namespace)).toContain('SmokeKb');
  });

  it('5. akcja noop: spawn → polling do success → SSE z pełną historią → log', async () => {
    const meRes = await app.inject({ method: 'GET', url: '/api/v1/me', cookies: { kag_sid: sid } });
    const userId = (meRes.json() as { data: { user: { id: string } } }).data.user.id;

    const row = startAction(
      { db, dataDir, jobEntry, killTimeoutMs: 2_000 },
      { type: 'noop', resource: 'smoke:noop', params: { sleepMs: 25 }, startedBy: userId },
    );

    // Polling przez API (jak zrobi to frontend) aż do statusu terminalnego.
    let status = 'running';
    const deadline = Date.now() + 8_000;
    while (status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/actions/${row.id}`,
        cookies: { kag_sid: sid },
      });
      expect(res.statusCode).toBe(200);
      status = (res.json() as { data: { status: string } }).data.status;
    }
    expect(status).toBe('success');

    // SSE po terminalu: progress + log + dokładnie jeden event status kończący strumień.
    const text = await readSseUntilEnd(`${baseUrl}/api/v1/actions/${row.id}/events`);
    const events = parseSse(text);
    const statuses = events.filter((e) => e.event === 'status');
    expect(statuses).toHaveLength(1);
    expect((statuses[0]!.data as { status: string }).status).toBe('success');
    const logLines = events
      .filter((e) => e.event === 'log')
      .flatMap((e) => (e.data as { lines: string[] }).lines);
    expect(logLines.some((l) => l.includes('noop: wszystkie kroki wykonane'))).toBe(true);

    const log = await app.inject({
      method: 'GET',
      url: `/api/v1/actions/${row.id}/log`,
      cookies: { kag_sid: sid },
    });
    expect(log.statusCode).toBe(200);
    expect(log.headers['content-type']).toContain('text/plain');
    expect(log.body).toContain('noop: wszystkie kroki wykonane');
  });

  it('6. settings: sekret sealowany, nigdy plaintext w DB ani w odpowiedziach', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/llm.chat',
      cookies: { kag_sid: sid },
      payload: {
        value: { baseUrl: 'https://llm.smoke/v1', model: 'smoke-chat', apiKey: 'sk-smoke-tajny-klucz-123' }, // gitleaks:allow — zmyślony sekret testowy
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain('sk-smoke-tajny-klucz-123');

    const get = await app.inject({ method: 'GET', url: '/api/v1/settings', cookies: { kag_sid: sid } });
    expect(get.statusCode).toBe(200);
    expect(get.body).not.toContain('sk-smoke-tajny-klucz-123');
    const chat = (get.json() as { data: Record<string, { configured: boolean; preview?: string }> })
      .data['llm.chat'];
    expect(chat?.configured).toBe(true);

    // W DB tylko sealed blob — plaintext sekretu nie występuje.
    const rowRaw = getSetting(db, 'llm.chat');
    expect(JSON.stringify(rowRaw)).not.toContain('sk-smoke-tajny-klucz-123');
  });

  it('7. klucz MCP: raw dokładnie raz przy tworzeniu, nigdy w listingu', async () => {
    const prof = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/profiles',
      cookies: { kag_sid: sid },
      payload: { id: 'smoke', name: 'Profil smoke', tools: ['kb_search', 'kb_list'], namespaces: ['SmokeKb'] },
    });
    expect(prof.statusCode).toBe(201);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/keys',
      cookies: { kag_sid: sid },
      payload: { label: 'smoke-key', profileId: 'smoke' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      data: { key: { id: string; prefix: string }; raw: string };
    };
    expect(body.data.raw.startsWith('sk-')).toBe(true);
    expect(body.data.raw.startsWith(body.data.key.prefix)).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/v1/mcp/keys', cookies: { kag_sid: sid } });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(body.data.raw);
    // W DB tylko hash sha256 — nigdy surowy klucz.
    const stored = db.prepare('SELECT hash FROM api_keys').all() as { hash: string }[];
    expect(stored.length).toBeGreaterThan(0);
    for (const k of stored) expect(k.hash).not.toBe(body.data.raw);
  });

  it('8. 405 na znanej ścieżce pod złą metodą — z nagłówkiem Allow', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/kbs', cookies: { kag_sid: sid } });
    expect(res.statusCode).toBe(405);
    expect(String(res.headers['allow'])).toContain('GET');
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('method_not_allowed');
  });
});
