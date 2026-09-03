import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { recordAnswer, type Db } from '@pomagierkb/shared/db';
import { makeTestApp, as } from './admin-helpers.js';
import { ASK_LIMIT_PER_MINUTE } from '../src/services/ask.js';

/**
 * /api/v1/ask — historia i feedback (viewer, tylko WŁASNE odpowiedzi):
 * - GET /ask/history: ostatnie odpowiedzi TEGO użytkownika z feedbackiem;
 * - POST /ask/:answerId/feedback: up/down (down → luka wiedzy przez repo),
 *   404 gdy answerId nie istnieje lub należy do innego użytkownika;
 * - dodatkowy limit ask 10/min per sesja → 429 (LLM nieskonfigurowany → 503,
 *   ale limit konsumowany PRZED bramką not_ready).
 */

let app: FastifyInstance;
let db: Db;

function seedAnswer(userId: string, question: string): string {
  return recordAnswer(db, {
    question,
    namespaces: ['LightingDocs'],
    citations: [{ n: 1, id: 'CHUNK_ld000001_001', namespace: 'LightingDocs' }],
    confidence: 0.8,
    model: 'chat-test',
    source: 'panel',
    userId,
    tookMs: 42,
  }).id;
}

beforeAll(async () => {
  ({ app, db } = await makeTestApp());
});

afterAll(async () => {
  await app.close();
  db.close();
});

describe('GET /api/v1/ask/history — tylko własne odpowiedzi', () => {
  it('viewer widzi swoje odpowiedzi (z feedbackiem), nie widzi cudzych', async () => {
    const mineA = seedAnswer('u-viewer', 'Pytanie własne A?');
    const mineB = seedAnswer('u-viewer', 'Pytanie własne B?');
    seedAnswer('u-operator', 'Pytanie cudze?');

    const fb = await app.inject({
      method: 'POST',
      url: `/api/v1/ask/${mineA}/feedback`,
      headers: as('viewer'),
      payload: { verdict: 'up' },
    });
    expect(fb.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/api/v1/ask/history', headers: as('viewer') });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as {
      data: {
        items: {
          id: string;
          question: string;
          feedback: { verdict: string }[];
          citations: unknown[];
          noAnswer: boolean;
        }[];
      };
    }).data.items;

    const ids = items.map((i) => i.id);
    expect(ids).toContain(mineA);
    expect(ids).toContain(mineB);
    expect(items.some((i) => i.question === 'Pytanie cudze?')).toBe(false);

    const withFb = items.find((i) => i.id === mineA)!;
    expect(withFb.feedback).toEqual([expect.objectContaining({ verdict: 'up' })]);
    expect(withFb.citations).toHaveLength(1);
    expect(withFb.noAnswer).toBe(false);
  });

  it('operator dostaje SWOJĄ historię (separacja per user)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ask/history', headers: as('operator') });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { data: { items: { question: string }[] } }).data.items;
    expect(items.every((i) => i.question === 'Pytanie cudze?')).toBe(true);
  });

  it('bez zalogowania → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ask/history' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/v1/ask/:answerId/feedback', () => {
  it('down z komentarzem → 201, luka wiedzy w DB (source feedback)', async () => {
    const answerId = seedAnswer('u-viewer', 'Pytanie z kciukiem w dół?');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/ask/${answerId}/feedback`,
      headers: as('viewer'),
      payload: { verdict: 'down', comment: 'Odpowiedź nie na temat' },
    });
    expect(res.statusCode).toBe(201);
    const data = (res.json() as {
      data: { feedback: { verdict: string; comment: string }; gapRecorded: boolean; gapId?: string };
    }).data;
    expect(data.feedback).toMatchObject({ verdict: 'down', comment: 'Odpowiedź nie na temat' });
    expect(data.gapRecorded).toBe(true);
    expect(data.gapId).toBeDefined();

    const gap = db.prepare('SELECT * FROM learning_gaps WHERE id = ?').get(data.gapId!) as {
      question: string;
      source: string;
      metadata_json: string;
    };
    expect(gap.question).toBe('Pytanie z kciukiem w dół?');
    expect(gap.source).toBe('feedback');
    expect(gap.metadata_json).toContain(answerId);
  });

  it('up → 201 bez luki', async () => {
    const answerId = seedAnswer('u-viewer', 'Pytanie z kciukiem w górę?');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/ask/${answerId}/feedback`,
      headers: as('viewer'),
      payload: { verdict: 'up' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { data: { gapRecorded: boolean } }).data.gapRecorded).toBe(false);
  });

  it('nieistniejący answerId → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ask/ans_20260901_ffffffff/feedback',
      headers: as('viewer'),
      payload: { verdict: 'up' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('cudza odpowiedź → 404 (bez zdradzania istnienia)', async () => {
    const foreignId = seedAnswer('u-operator', 'Cudza odpowiedź do oceny?');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/ask/${foreignId}/feedback`,
      headers: as('viewer'),
      payload: { verdict: 'down' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('zły verdict → 400 (schema)', async () => {
    const answerId = seedAnswer('u-viewer', 'Pytanie ze złym verdictem?');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/ask/${answerId}/feedback`,
      headers: as('viewer'),
      payload: { verdict: 'meh' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('limit ask 10/min per sesja', () => {
  it('11. pytanie w minucie → 429 rate_limited (osobna sesja testowa)', async () => {
    // LLM nieskonfigurowany → każda próba kończy się 503 not_ready,
    // ale limit per sesja jest konsumowany PRZED bramką LLM.
    for (let i = 0; i < ASK_LIMIT_PER_MINUTE; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        headers: as('viewer', 'u-limit'),
        payload: { question: `Pytanie limitowe numer ${i}?` },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe('not_ready');
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers: as('viewer', 'u-limit'),
      payload: { question: 'Pytanie ponad limit?' },
    });
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('rate_limited');

    // Inna sesja NIE jest objęta tym limitem.
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers: as('viewer'),
      payload: { question: 'Pytanie innej sesji?' },
    });
    expect(other.statusCode).toBe(503);
  });
});
