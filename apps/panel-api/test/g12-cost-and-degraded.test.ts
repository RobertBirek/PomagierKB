import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createKb, replaceForDocument, setSetting, transitionKb, type Db } from '@pomagierkb/shared/db';
import { seal } from '@pomagierkb/shared/crypto';
import { as, makeTestApp } from './admin-helpers.js';
import { llmFromSettings } from '../src/pipeline/intake-worker.js';

/**
 * G12 — domknięcie GAP-05 i D8-03/D8-08/D8-10 na ścieżce panelowego /ask:
 *  - koszt LLM: embeddingi zapytań i reranku szły POZA `withBreaker`, więc nie
 *    trafiały do `llm_usage` w ogóle; czat trafiał, ale bez atrybucji wołającego,
 *  - `answers.model` było NULL (sealed 'llm.chat') — teraz z ChatResult.model,
 *  - `answers.answer_text` — treść odpowiedzi utrwalona (sędzia jakości),
 *  - SSE `result` niesie `degradedReasons` obok niezmienionego boola `degraded`.
 */

const QUESTION = 'Maksymalne obciążenie szynoprzewodów przy montażu?';
const CHAT_TEXT = 'Na podstawie źródła [1] maksymalne obciążenie wynosi 16 A na fazę.\nCONFIDENCE: 0.8';

interface MockLlmServer {
  baseUrl: string;
  chatCalls: () => number;
  embedCalls: () => number;
  close: () => Promise<void>;
}

/** Mock OpenAI-compatible: chat + embeddings, oba z blokiem `usage`. */
async function startMockLlm(): Promise<MockLlmServer> {
  let chatCalls = 0;
  let embedCalls = 0;
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      chatCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'chat-test',
          choices: [{ index: 0, message: { role: 'assistant', content: CHAT_TEXT }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.endsWith('/embeddings')) {
      embedCalls += 1;
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { input?: string[] };
        const inputs = Array.isArray(parsed.input) ? parsed.input : [''];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            model: 'chat-test',
            data: inputs.map((_t, index) => ({ object: 'embedding', index, embedding: [1, 0, 0] })),
            usage: { prompt_tokens: 7, total_tokens: 7 },
          }),
        );
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock LLM: nieoczekiwana ścieżka ${url}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    chatCalls: () => chatCalls,
    embedCalls: () => embedCalls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const eventLine = lines.find((l) => l.startsWith('event: '));
    const dataLine = lines.find((l) => l.startsWith('data: '));
    if (eventLine === undefined || dataLine === undefined) continue;
    events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> });
  }
  return events;
}

interface UsageRow {
  endpoint: string;
  purpose: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
}

let app: FastifyInstance;
let db: Db;
let llm: MockLlmServer;

beforeAll(async () => {
  llm = await startMockLlm();
  // OpenSPG nieosiągalny (port 1 → ECONNREFUSED): retrieval degraduje się do FTS5.
  ({ app, db } = await makeTestApp({
    openspg: { baseUrl: 'http://127.0.0.1:1', account: 'openspg', password: 'x' },
  }));

  createKb(db, { namespace: 'LightingDocs', name: 'Baza oświetleniowa' });
  transitionKb(db, 'LightingDocs', 'provisioning');
  transitionKb(db, 'LightingDocs', 'active');
  // DWA chunki: rerank 'embed' (domyślny) rusza dopiero od 2 trafień — a to on
  // jest ścieżką embeddingów, której koszt dotąd w ogóle nie był mierzony.
  replaceForDocument(db, 'LightingDocs', 'doc1', [
    {
      id: 'CHUNK_ld000001_001',
      title: 'Montaż szynoprzewodów',
      content:
        'Przy montażu na szynoprzewodach trójfazowych maksymalne obciążenie toru wynosi 16 amperów na fazę.',
      sourceRef: 'https://example.com/karta.pdf',
    },
    {
      id: 'CHUNK_ld000001_002',
      title: 'Montaż szynoprzewodów — uwagi',
      content:
        'Maksymalne obciążenie szynoprzewodów przy montażu podwieszanym rozkłada się równomiernie na wszystkie fazy.',
      sourceRef: 'https://example.com/karta.pdf',
    },
  ]);

  const keyB64 = app.config.tokenEncKey.toString('base64');
  setSetting(
    db,
    'llm.chat',
    { baseUrl: llm.baseUrl, apiKey: 'sk-test-chat', model: 'chat-test' }, // gitleaks:allow
    { isSecret: true, seal: (plain) => seal(plain, keyB64) },
  );
});

afterAll(async () => {
  await app.close();
  db.close();
  await llm.close();
});

describe('POST /api/v1/ask — koszt LLM, model i powody degradacji', () => {
  it('rejestruje zużycie czatu I embeddingów, bez podwójnego liczenia', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers: as('viewer'),
      payload: { question: QUESTION, namespaces: ['LightingDocs'] },
    });
    expect(res.statusCode).toBe(200);

    const result = parseSse(res.body).find((e) => e.event === 'result')!.data as {
      answer: string;
      degraded: boolean;
      degradedReasons: string[];
      answerId: string;
      noAnswer: boolean;
    };
    expect(result.noAnswer).toBe(false);

    // D8-03/D8-10: bool bez zmian + powody obok niego. KB nie jest zprovisionowana
    // (project_id NULL), więc kanał tekstowy „działa” z zerem trafień, a mirror
    // trafia — dokładnie ten przypadek, którego sam bool nie odróżniał od awarii.
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons).toContain('openspg_no_hits');
    expect(result.degradedReasons).not.toContain('openspg_down'); // to NIE jest awaria OpenSPG

    expect(llm.embedCalls()).toBe(1); // rerank 'embed' — ścieżka poza withBreaker
    const usage = db.prepare('SELECT * FROM llm_usage ORDER BY id').all() as UsageRow[];
    const chat = usage.filter((u) => u.endpoint === 'chat');
    const embed = usage.filter((u) => u.endpoint === 'embeddings');

    // GAP-05: dotąd embeddingi (rerank zapytania) NIE trafiały do rejestru wcale.
    expect(embed.length).toBeGreaterThan(0);
    expect(embed[0]?.purpose).toBe('panel.ask.embed');
    expect(embed[0]?.model).toBe('chat-test');
    expect(embed[0]?.prompt_tokens).toBe(7);

    // Czat policzony DOKŁADNIE raz (flaga usageReported chroni przed dublem
    // między callbackiem klienta a withBreaker).
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ purpose: 'panel.ask.chat', model: 'chat-test' });
    expect(chat[0]?.prompt_tokens).toBe(10);
    expect(chat[0]?.completion_tokens).toBe(20);
    expect(llm.chatCalls()).toBe(1);

    // GAP-05 + D8-08: model z ChatResult mimo zapieczętowanego 'llm.chat'; treść utrwalona.
    const row = db.prepare('SELECT * FROM answers WHERE id = ?').get(result.answerId) as {
      model: string | null;
      answer_text: string | null;
      from_cache: number;
    };
    expect(row.model).toBe('chat-test');
    expect(row.answer_text).toBe(result.answer);
    expect(row.from_cache).toBe(0);
  });
});

describe('pipeline ingestu: koszt analizy LLM w rejestrze (GAP-05)', () => {
  it('llmFromSettings raportuje zużycie z etykietą etapu (dotąd zero wierszy)', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM llm_usage').get() as { n: number }).n;
    const client = llmFromSettings(db, app.config, 'llm.chat');
    expect(client).not.toBeNull();
    await client!.chat({ system: 'system', user: 'treść dokumentu do analizy' });

    const rows = db
      .prepare('SELECT endpoint, purpose, model, prompt_tokens FROM llm_usage ORDER BY id')
      .all() as UsageRow[];
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1]).toMatchObject({
      endpoint: 'chat',
      purpose: 'ingest.analyze', // analiza ingestu idzie POZA withBreaker
      model: 'chat-test',
      prompt_tokens: 10,
    });
  });
});
