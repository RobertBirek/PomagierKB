import { describe, expect, it } from 'vitest';
import { createLlmClient } from '../src/llm/index.js';

// Mock przez wstrzyknięcie fetch do SDK openai (maxRetries:0 → każda próba = 1 request).

interface StubResponse {
  status: number;
  body: unknown;
}

function makeFetch(queue: StubResponse[]) {
  const requests: { url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const next = queue.shift();
    if (!next) throw new Error('mock fetch: brak zaplanowanej odpowiedzi');
    requests.push({ url: String(input), body: String(init?.body ?? '') });
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchImpl, requests };
}

function chatCompletion(content: string): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  };
}

const apiError = (message: string): unknown => ({ error: { message, type: 'server_error' } });
const noSleep = (): Promise<void> => Promise.resolve();

function makeClient(fetchImpl: typeof fetch) {
  return createLlmClient({
    baseUrl: 'http://llm.test/v1',
    apiKey: 'sk-test-nie-loguj',
    model: 'test-model',
    fetch: fetchImpl,
    sleep: noSleep,
  });
}

describe('createLlmClient.chat', () => {
  it('ponawia raz po 5xx i zwraca wynik', async () => {
    const { fetchImpl, requests } = makeFetch([
      { status: 500, body: apiError('boom') },
      { status: 200, body: chatCompletion('odpowiedź') },
    ]);
    const client = makeClient(fetchImpl);
    const res = await client.chat({ system: 'sys', user: 'pytanie' });
    expect(res.text).toBe('odpowiedź');
    expect(res.usage).toEqual({ promptTokens: 7, completionTokens: 3 });
    expect(requests).toHaveLength(2);
  });

  it('po drugim 5xx rzuca upstream_error (dokładnie 1 ponowienie)', async () => {
    const { fetchImpl, requests } = makeFetch([
      { status: 502, body: apiError('boom1') },
      { status: 503, body: apiError('boom2') },
    ]);
    const client = makeClient(fetchImpl);
    await expect(client.chat({ system: 's', user: 'u' })).rejects.toMatchObject({
      code: 'upstream_error',
      details: { service: 'llm', endpoint: 'chat', status: 503 },
    });
    expect(requests).toHaveLength(2);
  });

  it('nie ponawia na 400 bez jsonSchema', async () => {
    const { fetchImpl, requests } = makeFetch([{ status: 400, body: apiError('zły request') }]);
    const client = makeClient(fetchImpl);
    await expect(client.chat({ system: 's', user: 'u' })).rejects.toMatchObject({
      code: 'upstream_error',
    });
    expect(requests).toHaveLength(1);
  });

  it('structured outputs: fallback json_object po 400 na json_schema i własny parse', async () => {
    const { fetchImpl, requests } = makeFetch([
      { status: 400, body: apiError('response_format json_schema unsupported') },
      { status: 200, body: chatCompletion('{"tytul":"Test","tagi":["a"]}') },
    ]);
    const client = makeClient(fetchImpl);
    const res = await client.chat({
      system: 's',
      user: 'u',
      jsonSchema: { type: 'object', properties: { tytul: { type: 'string' } } },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toContain('"json_schema"');
    expect(requests[1]?.body).toContain('"json_object"');
    expect(res.parsed).toEqual({ tytul: 'Test', tagi: ['a'] });
  });

  it('structured outputs: parsuje odpowiedź gdy serwer wspiera json_schema', async () => {
    const { fetchImpl, requests } = makeFetch([{ status: 200, body: chatCompletion('{"ok":true}') }]);
    const client = makeClient(fetchImpl);
    const res = await client.chat({ system: 's', user: 'u', jsonSchema: { type: 'object' } });
    expect(requests).toHaveLength(1);
    expect(res.parsed).toEqual({ ok: true });
  });
});

describe('createLlmClient.embed', () => {
  it('zwraca wektory w kolejności pola index', async () => {
    const { fetchImpl } = makeFetch([
      {
        status: 200,
        body: {
          object: 'list',
          model: 'test-model',
          data: [
            { object: 'embedding', index: 1, embedding: [3, 4] },
            { object: 'embedding', index: 0, embedding: [1, 2] },
          ],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        },
      },
    ]);
    const client = makeClient(fetchImpl);
    await expect(client.embed(['a', 'b'])).resolves.toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('ponawia raz po 429', async () => {
    const { fetchImpl, requests } = makeFetch([
      { status: 429, body: apiError('rate limited') },
      {
        status: 200,
        body: {
          object: 'list',
          model: 'test-model',
          data: [{ object: 'embedding', index: 0, embedding: [0.5] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        },
      },
    ]);
    const client = makeClient(fetchImpl);
    await expect(client.embed(['a'])).resolves.toEqual([[0.5]]);
    expect(requests).toHaveLength(2);
  });

  it('pusta lista tekstów nie wywołuje API', async () => {
    const { fetchImpl, requests } = makeFetch([]);
    const client = makeClient(fetchImpl);
    await expect(client.embed([])).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });
});
