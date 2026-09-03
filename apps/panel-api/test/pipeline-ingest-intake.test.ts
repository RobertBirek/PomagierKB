import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createKb, getDraft, transitionKb, type Db } from '@pomagierkb/shared/db';
import { makeTestApp, as } from './admin-helpers.js';
import { startIntakeWorker, tickIntakeWorker } from '../src/pipeline/intake-worker.js';
import { getIntake } from '../src/services/intakes.js';
import { MESSAGES } from '../src/services/messages.js';

/**
 * Intake E2E (pipeline-frontend §c Etap 1+worker): POST /api/v1/content(text)
 * → 202 {intakeId} → worker przechodzi statusy received→...→drafted → draft
 * pending w DB z metadata.intakeId; Idempotency-Key i dedup po sha256 → 200
 * z istniejącym id; upload złego rozszerzenia → 400; zły UTF-8 → failed
 * z ludzkim komunikatem; RBAC (viewer nie doda treści).
 */

let app: FastifyInstance;
let db: Db;
let dataDir: string;

/** Deps workera bez sieci i bez LLM (tekstowa ścieżka raw + heurystyki). */
const offlineDeps = {
  chatLlm: null,
  openieLlm: null,
  aiClean: false,
  fetchImpl: (async () => {
    throw new Error('test offline: HTTP zabronione');
  }) as typeof globalThis.fetch,
};

const TEXT =
  'Oświetlenie awaryjne w halach przemysłowych montuje się nad drogami ewakuacyjnymi. ' +
  'Natężenie na osi drogi ewakuacyjnej nie może być mniejsze niż jeden luks, a czas ' +
  'działania oświetlenia wynosi co najmniej godzinę.';

async function tick(): Promise<number> {
  return tickIntakeWorker(db, app.config, offlineDeps);
}

function multipartPayload(filename: string, content: Buffer | string, boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'kag-intake-test-'));
  ({ app, db } = await makeTestApp({ dataDir }));
  // Aktywna baza z routing keywords — heurystyka analyze ma gdzie kierować.
  createKb(db, { namespace: 'LightingDocs', name: 'Oświetlenie', routingKeywords: ['oświetlenie', 'luks'] });
  transitionKb(db, 'LightingDocs', 'provisioning');
  transitionKb(db, 'LightingDocs', 'active');
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/v1/content (JSON text) → worker → draft pending', () => {
  let intakeId = '';

  it('202 {intakeId}, wpis intakes w statusie received', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('operator'), 'content-type': 'application/json' },
      payload: { text: TEXT, title: 'Notatka o oświetleniu awaryjnym' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { ok: true; data: { intakeId: string; status: string } };
    expect(body.ok).toBe(true);
    intakeId = body.data.intakeId;
    expect(intakeId).toMatch(/^intake_\d{8}_[0-9a-f]{8}$/);
    expect(body.data.status).toBe('received');
    expect(getIntake(db, intakeId)?.status).toBe('received');
  });

  it('worker przechodzi statusy do drafted; draft pending z metadata.intakeId', async () => {
    const processed = await tick();
    expect(processed).toBeGreaterThanOrEqual(1);

    const row = getIntake(db, intakeId)!;
    expect(row.status).toBe('drafted');
    expect(row.extract_provider).toBe('raw');
    expect(row.extract_quality).toBeGreaterThan(0.72);
    expect(row.clean_profile).toBe('generic');
    expect(row.cleaned_chars).toBeGreaterThan(100);
    expect(row.draft_id).not.toBeNull();

    const analysis = JSON.parse(row.analysis_json!) as { provider: string; kbNamespace: string };
    expect(analysis.provider).toBe('heuristic'); // chatLlm: null → fallback
    expect(analysis.kbNamespace).toBe('LightingDocs'); // routing keyword 'oświetlenie'

    const draft = getDraft(db, row.draft_id!)!;
    expect(draft.status).toBe('pending');
    expect(draft.namespace).toBe('LightingDocs');
    expect(draft.source_type).toBe('text');
    expect(draft.title).toBe('Notatka o oświetleniu awaryjnym'); // titleHint z title
    const metadata = JSON.parse(draft.metadata_json) as { intakeId: string; analyzeProvider: string };
    expect(metadata.intakeId).toBe(intakeId);
    expect(metadata.analyzeProvider).toBe('heuristic');
  });

  it('GET /content/:intakeId — etapy humanized (stepper), status drafted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/content/${intakeId}`,
      headers: as('viewer'),
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as {
      data: { intake: { status: string; statusHuman: { label: string }; stages: { stage: string; label: string; reached: boolean }[] } };
    };
    expect(data.intake.status).toBe('drafted');
    expect(data.intake.statusHuman.label).toBe('szkic utworzony');
    expect(data.intake.stages).toHaveLength(5);
    expect(data.intake.stages.every((s) => s.reached)).toBe(true);
    expect(data.intake.stages.every((s) => s.label !== s.stage)).toBe(true); // PL, nie kody
  });

  it('dedup po sha256: ten sam tekst → 200 z istniejącym intakeId i draftId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('operator'), 'content-type': 'application/json' },
      payload: { text: TEXT, title: 'Inny tytuł, ta sama treść' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { intakeId: string; draftId: string; deduplicated: boolean } };
    expect(body.data.intakeId).toBe(intakeId);
    expect(body.data.deduplicated).toBe(true);
    expect(body.data.draftId).not.toBeNull();
  });

  it('GET /content?limit — lista ostatnich intake z ludzkim statusem', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/content?limit=10', headers: as('viewer') });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { items: { id: string; statusHuman: { label: string } }[] } };
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    expect(data.items.some((i) => i.id === intakeId)).toBe(true);
    expect(data.items[0]!.statusHuman.label).toBeTruthy();
  });
});

describe('Idempotency-Key', () => {
  it('powtórka z tym samym kluczem zwraca ten sam intakeId (200, bez duplikatu)', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('operator'), 'content-type': 'application/json', 'idempotency-key': 'idem-abc-1' },
      payload: { text: `${TEXT} Wersja idempotentna.` },
    });
    expect(first.statusCode).toBe(202);
    const firstId = (first.json() as { data: { intakeId: string } }).data.intakeId;

    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('operator'), 'content-type': 'application/json', 'idempotency-key': 'idem-abc-1' },
      payload: { text: 'Zupełnie inna treść — klucz idempotencji ma pierwszeństwo.' },
    });
    expect(again.statusCode).toBe(200);
    const againBody = again.json() as { data: { intakeId: string; deduplicated: boolean } };
    expect(againBody.data.intakeId).toBe(firstId);
    expect(againBody.data.deduplicated).toBe(true);
  });
});

describe('upload multipart', () => {
  it('złe rozszerzenie → 400 validation_error z whitelistą', async () => {
    const boundary = 'testboundary400';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('operator'), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload('wirus.exe', 'MZ...', boundary),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: false; error: { code: string; details?: { allowedExtensions?: string[] } } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details?.allowedExtensions).toContain('pdf');
  });

  it('plik .md → 202, worker robi z niego szkic (provider raw)', async () => {
    const boundary = 'testboundarymd';
    const md = `# Konserwacja opraw\n\n${TEXT} Przegląd wykonuje się co dwanaście miesięcy.`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('operator'), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload('konserwacja.md', md, boundary),
    });
    expect(res.statusCode).toBe(202);
    const id = (res.json() as { data: { intakeId: string } }).data.intakeId;

    await tick();
    const row = getIntake(db, id)!;
    expect(row.status).toBe('drafted');
    expect(row.source_kind).toBe('upload');
    expect(row.mime).toBe('text/markdown');
    const draft = getDraft(db, row.draft_id!)!;
    expect(draft.title).toBe('Konserwacja opraw'); // H1 (brak titleHint lepszego niż plik)
    expect(draft.source_type).toBe('upload');
  });

  it('plik .txt z niepoprawnym UTF-8 → failed z ludzkim komunikatem', async () => {
    const boundary = 'testboundarybad';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('operator'), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload('smieci.txt', Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x41]), boundary),
    });
    expect(res.statusCode).toBe(202);
    const id = (res.json() as { data: { intakeId: string } }).data.intakeId;

    await tick();
    const row = getIntake(db, id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toBe('invalid_encoding');

    const detail = await app.inject({ method: 'GET', url: `/api/v1/content/${id}`, headers: as('viewer') });
    const { data } = detail.json() as { data: { intake: { errorHuman: { label: string } } } };
    expect(data.intake.errorHuman.label).toBe(MESSAGES['invalid_encoding']!.label);
  });
});

describe('walidacja i RBAC', () => {
  it('JSON bez text → 400; nieznane pola → 400; zły sourceUrl → 400', async () => {
    for (const payload of [{}, { text: TEXT, extra: 1 }, { text: TEXT, sourceUrl: 'ftp://x' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/content',
        headers: { ...as('operator'), 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('validation_error');
    }
  });

  it('viewer nie doda treści (403), anonim 401', async () => {
    const viewer = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('viewer'), 'content-type': 'application/json' },
      payload: { text: TEXT },
    });
    expect(viewer.statusCode).toBe(403);
    const anon = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { 'content-type': 'application/json' },
      payload: { text: TEXT },
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('POST /content/:id/retry (ponowienie nieudanego intake)', () => {
  it('failed → received → worker kończy draftem; limit prób → 409', async () => {
    // Zły UTF-8 w .txt → worker ustawia failed
    const boundary = 'B-retry-1';
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('operator'), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload('zle.txt', Buffer.from([0xff, 0xfe, 0x00, 0x81]), boundary),
    });
    expect(bad.statusCode).toBe(202);
    const intakeId = (bad.json() as { data: { intakeId: string } }).data.intakeId;
    await tick();
    expect(getIntake(db, intakeId)?.status).toBe('failed');

    // retry × 3 (limit INTAKE_MAX_ATTEMPTS) — za każdym razem znowu failed
    for (let i = 1; i <= 3; i++) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/content/${intakeId}/retry`,
        headers: as('operator'),
      });
      expect(r.statusCode).toBe(200);
      expect((r.json() as { data: { attempts: number } }).data.attempts).toBe(i);
      await tick();
      expect(getIntake(db, intakeId)?.status).toBe('failed');
    }
    // 4. próba → 409 (wyczerpane)
    const exhausted = await app.inject({
      method: 'POST',
      url: `/api/v1/content/${intakeId}/retry`,
      headers: as('operator'),
    });
    expect(exhausted.statusCode).toBe(409);
  });

  it('retry intake w stanie innym niż failed → 409; viewer → 403', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('operator'), 'content-type': 'application/json' },
      payload: { text: `${TEXT} Wariant do testu retry.` },
    });
    const intakeId = (ok.json() as { data: { intakeId: string } }).data.intakeId;
    await tick(); // drafted
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/content/${intakeId}/retry`,
      headers: as('operator'),
    });
    expect(conflict.statusCode).toBe(409);
    const viewer = await app.inject({
      method: 'POST',
      url: `/api/v1/content/${intakeId}/retry`,
      headers: as('viewer'),
    });
    expect(viewer.statusCode).toBe(403);
  });
});

describe('startIntakeWorker (pętla interwałowa)', () => {
  it('przetwarza kolejkę w tle i daje się zatrzymać', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/content',
      headers: { ...as('operator'), 'content-type': 'application/json' },
      payload: { text: `${TEXT} Wpis do testu pętli workera.` },
    });
    const id = (res.json() as { data: { intakeId: string } }).data.intakeId;

    const worker = startIntakeWorker({ db, config: app.config, intervalMs: 20, deps: offlineDeps });
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && getIntake(db, id)!.status === 'received') {
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      worker.stop();
    }
    expect(getIntake(db, id)!.status).toBe('drafted');
  });
});
