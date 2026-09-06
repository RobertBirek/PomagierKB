import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSetting, type Db } from '@pomagierkb/shared/db';
import { seal } from '@pomagierkb/shared/crypto';
import { randomBytes } from 'node:crypto';
import { buildToolLlm } from '../src/config.js';
import type { McpConfig } from '../src/config.js';
import { testDb } from './helpers-tools.js';

/**
 * G12/GAP-05: `recordLlmUsage` wisiało wyłącznie na `withBreaker`, który widzi
 * tylko wyniki niosące `usage` (czat). Embeddingi zapytań kb_search/kb_answer
 * wracają jako `number[][]`, więc ich koszt nie trafiał do rejestru w OGÓLE.
 * Teraz zgłasza je callback `onUsage` klienta — a flaga `usageReported` pilnuje,
 * żeby czatu nie policzyć drugi raz w withBreaker.
 */

interface MockLlm {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startMockLlm(): Promise<MockLlm> {
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          created: 0,
          model: 'chat-test',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        }),
      );
      return;
    }
    if (url.endsWith('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          model: 'chat-test',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
      );
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface UsageRow {
  endpoint: string;
  purpose: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
}

let mock: MockLlm;
let db: Db;
let config: McpConfig;

beforeAll(async () => {
  mock = await startMockLlm();
  db = testDb();
  const keyB64 = randomBytes(32).toString('base64');
  setSetting(
    db,
    'llm.chat',
    { baseUrl: mock.baseUrl, apiKey: 'sk-test-mcp', model: 'chat-test' }, // gitleaks:allow
    { isSecret: true, seal: (plain) => seal(plain, keyB64) },
  );
  config = { tokenEncKey: keyB64 } as McpConfig;
});

afterAll(async () => {
  db.close();
  await mock.close();
});

describe('buildToolLlm: rejestr kosztu MCP (GAP-05)', () => {
  it('czat liczony raz, embeddingi liczone w ogóle — z etykietami mcp.*', async () => {
    const llm = buildToolLlm(db, config);
    expect(llm).not.toBeNull();

    await llm!.chat({ system: 's', user: 'u' });
    await llm!.embed(['zapytanie']);

    const rows = db.prepare('SELECT * FROM llm_usage ORDER BY id').all() as UsageRow[];
    const chat = rows.filter((r) => r.endpoint === 'chat');
    const embed = rows.filter((r) => r.endpoint === 'embeddings');

    expect(chat).toHaveLength(1); // bez dubla klient/withBreaker
    expect(chat[0]).toMatchObject({
      purpose: 'mcp.chat',
      model: 'chat-test',
      prompt_tokens: 11,
      completion_tokens: 22,
    });

    expect(embed).toHaveLength(1); // dotąd: ZERO wierszy
    expect(embed[0]).toMatchObject({ purpose: 'mcp.embed', model: 'chat-test', prompt_tokens: 5 });
  });

  it('przekazuje logger przejść breakera (D8-10) i nie wywraca wywołania', async () => {
    const seen: string[] = [];
    const logger = {
      info: () => undefined,
      warn: (obj: Record<string, unknown>) => {
        if (typeof obj['breaker'] === 'string') seen.push(`${String(obj['from'])}->${String(obj['to'])}`);
      },
    };
    const llm = buildToolLlm(db, config, logger);
    expect(llm).not.toBeNull();
    // Zdrowe wywołanie NIE generuje przejścia — logger milczy (zero szumu w logu).
    await llm!.chat({ system: 's', user: 'u' });
    expect(seen).toEqual([]);
  });
});
