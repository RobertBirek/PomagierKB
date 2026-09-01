import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createKb,
  replaceForDocument,
  setSetting,
  transitionKb,
  type Db,
} from '@pomagierkb/shared/db';
import { seal } from '@pomagierkb/shared/crypto';
import { makeTestApp, as } from './admin-helpers.js';
import { ANSWER_PHASES, MESSAGES } from '../src/services/messages.js';

/**
 * POST /api/v1/ask — pełny przepływ SSE (pipeline WSPÓLNY z MCP przez
 * packages/shared/answer): status(retrieval) → status(generating) → result
 * z answerId i cytowaniami; zapis answers z source 'panel' + user_id.
 * LLM = mock HTTP (lokalny serwer node:http z licznikiem wywołań chatu),
 * OpenSPG niedostępny (connection refused → retrieval degraduje się do FTS5).
 * Bramka no_answer: ZERO wywołań chatu + luka wiedzy w DB.
 */

const QUESTION = 'Maksymalne obciążenie szynoprzewodów przy montażu?';
const CHAT_TEXT = 'Na podstawie źródła [1] maksymalne obciążenie wynosi 16 A na fazę.\nCONFIDENCE: 0.8';

interface MockLlmServer {
  baseUrl: string;
  chatCalls: () => number;
  close: () => Promise<void>;
}

/** Lokalny mock OpenAI-compatible: POST /v1/chat/completions ze stałą treścią. */
async function startMockLlm(): Promise<MockLlmServer> {
  let chatCalls = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      chatCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'chat-test',
          choices: [
            { index: 0, message: { role: 'assistant', content: CHAT_TEXT }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock LLM: nieoczekiwana ścieżka ${req.url}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    chatCalls: () => chatCalls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of text.split('\n\n')) {
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (eventLine === undefined || dataLine === undefined) continue; // komentarze/heartbeat
    events.push({
      event: eventLine.slice(7),
      data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
    });
  }
  return events;
}

let app: FastifyInstance;
let db: Db;
let llm: MockLlmServer;

beforeAll(async () => {
  llm = await startMockLlm();
  // OpenSPG celowo NIEOSIĄGALNY (port 1 → natychmiastowy ECONNREFUSED):
  // kanały openspg_vector/openspg_text zwracają null, retrieval = FTS5 + degraded.
  ({ app, db } = await makeTestApp({
    openspg: { baseUrl: 'http://127.0.0.1:1', account: 'openspg', password: 'x' },
  }));

  // KB active + chunki w mirrorze FTS (bez embedding_model → kanał wektorowy wyłączony).
  createKb(db, { namespace: 'LightingDocs', name: 'Baza oświetleniowa' });
  transitionKb(db, 'LightingDocs', 'provisioning');
  transitionKb(db, 'LightingDocs', 'active');
  replaceForDocument(db, 'LightingDocs', 'doc1', [
    {
      id: 'LightingDocs:Chunk:1',
      title: 'Montaż szynoprzewodów',
      content:
        'Przy montażu na szynoprzewodach trójfazowych maksymalne obciążenie toru wynosi 16 amperów na fazę.',
      sourceRef: 'https://example.com/karta.pdf',
    },
  ]);

  // llm.chat w settings — sealed AES-GCM kluczem z configu (prawdziwa ścieżka unseal).
  const keyB64 = app.config.tokenEncKey.toString('base64');
  setSetting(
    db,
    'llm.chat',
    { baseUrl: llm.baseUrl, apiKey: 'sk-test-chat', model: 'chat-test' },
    { isSecret: true, seal: (plain) => seal(plain, keyB64) },
  );
});

afterAll(async () => {
  await app.close();
  db.close();
  await llm.close();
});

describe('słownik komunikatów PL — etapy odpowiedzi /ask', () => {
  it('każda faza ANSWER_PHASES ma wpis z niepustą etykietą', () => {
    for (const phase of ANSWER_PHASES) {
      const entry = MESSAGES[phase];
      expect(entry, `brak wpisu w MESSAGES dla '${phase}'`).toBeDefined();
      expect(entry!.label.length).toBeGreaterThan(0);
      expect(entry!.label).not.toBe(phase);
    }
  });
});

describe('POST /api/v1/ask — pełny przepływ SSE', () => {
  it('status(retrieval) → status(generating) → result z answerId i cytowaniami; zapis answers panel+user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers: as('viewer'),
      payload: { question: QUESTION, namespaces: ['LightingDocs'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.body);
    const statuses = events.filter((e) => e.event === 'status').map((e) => e.data['phase']);
    expect(statuses).toEqual(['retrieval', 'generating']);

    const results = events.filter((e) => e.event === 'result');
    expect(results).toHaveLength(1);
    const result = results[0]!.data as {
      answer: string;
      citations: { n: number; id: string; namespace: string }[];
      confidence: number;
      noAnswer: boolean;
      degraded: boolean;
      answerId: string;
    };
    expect(result.answer).toContain('[1]');
    expect(result.noAnswer).toBe(false);
    expect(result.degraded).toBe(true); // OpenSPG nieosiągalny → tylko FTS5
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0]).toMatchObject({ n: 1, id: 'LightingDocs:Chunk:1', namespace: 'LightingDocs' });
    expect(result.answerId).toMatch(/^ans_\d{8}_[0-9a-f]{8}$/);

    expect(llm.chatCalls()).toBe(1);

    const row = db.prepare('SELECT * FROM answers WHERE id = ?').get(result.answerId) as {
      source: string;
      user_id: string;
      no_answer: number;
    };
    expect(row).toMatchObject({ source: 'panel', user_id: 'u-viewer', no_answer: 0 });
  });

  it('bramka no_answer: BEZ wywołania chatu (licznik mocka) + luka wiedzy w DB', async () => {
    const before = llm.chatCalls();
    const question = 'Ile kosztuje bilet miesięczny w Krakowie?';

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers: as('viewer'),
      payload: { question },
    });

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    // Tylko faza retrieval — do LLM w ogóle nie dochodzi.
    expect(events.filter((e) => e.event === 'status').map((e) => e.data['phase'])).toEqual(['retrieval']);

    const result = events.find((e) => e.event === 'result')!.data as {
      noAnswer: boolean;
      confidence: number;
      citations: unknown[];
      answerId: string;
    };
    expect(result.noAnswer).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.citations).toEqual([]);

    expect(llm.chatCalls()).toBe(before); // zero kosztu LLM

    const gap = db
      .prepare('SELECT * FROM learning_gaps WHERE question = ?')
      .get(question) as { source: string; metadata_json: string } | undefined;
    expect(gap).toBeDefined();
    expect(gap!.metadata_json).toContain('no_answer_gate');

    const answerRow = db.prepare('SELECT * FROM answers WHERE id = ?').get(result.answerId) as {
      source: string;
      user_id: string;
      no_answer: number;
    };
    expect(answerRow).toMatchObject({ source: 'panel', user_id: 'u-viewer', no_answer: 1 });
  });

  it('nieznane/nieaktywne namespaces → 400 kopertą PRZED strumieniem', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers: as('viewer'),
      payload: { question: QUESTION, namespaces: ['NoSuchKb'] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('validation_error');
  });

  it('walidacja body: pytanie krótsze niż 5 znaków → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers: as('viewer'),
      payload: { question: 'abc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('bez zalogowania → 401 (rbac viewer)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      payload: { question: QUESTION },
    });
    expect(res.statusCode).toBe(401);
  });
});
