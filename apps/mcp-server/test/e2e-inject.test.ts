import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KNOWN_MCP_TOOLS, createKey, createProfile } from '@pomagierkb/shared/db';
import { ALL_TOOLS } from '../src/tools/index.js';
import { mockLlm, seedKb, seedLightingChunks, type MockLlm } from './helpers-tools.js';
import {
  initializeBody,
  makeHarness,
  makeUser,
  mcpRequest,
  toolsCallBody,
  toolsListBody,
  type TestHarness,
} from './helpers.js';

/**
 * E2E przez inject (bez sieci): initialize → tools/list → tools/call kb_search
 * i kb_answer (mock LLM wstrzyknięty przez DI llmProvider fabryki buildServer)
 * → kb_submit_draft kluczem write z weryfikacją draftu w DB; klucz read na
 * narzędziu write → JSON-RPC -32003. OpenSPG null → retrieval przez FTS5
 * (degraded:true) — ścieżka fallbacku §7.5 pod pełnym transportem.
 */

// buildMatchExpression łączy tokeny AND-em — pytanie tylko ze słów obecnych w chunku.
const QUESTION = 'Maksymalne obciążenie szynoprzewodów przy montażu?';

const DRAFT_CONTENT =
  'Szynoprzewody trójfazowe: maksymalne obciążenie toru wynosi 16 A na fazę; ' +
  'przy dłuższych torach stosować zasilanie środkowe, aby ograniczyć spadki napięcia.';

interface RpcEnvelope<T> {
  result: T;
  error?: { code: number; message: string };
}

interface CallResult {
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

describe('E2E mcp-server: pełny przepływ narzędzi przez transport Streamable HTTP', () => {
  let h: TestHarness;
  let mock: MockLlm;
  let readKey: string; // profil default (bez write w tools_json)
  let writeKey: string; // profil full, scopes [read, write]
  let readOnFullKey: string; // profil full, scope read → -32003 na submit

  beforeEach(() => {
    mock = mockLlm();
    h = makeHarness({ tools: ALL_TOOLS, llmProvider: () => mock.llm });
    seedKb(h.db, 'LightingDocs');
    seedLightingChunks(h.db);
    const reader = makeUser(h.db, 'usr_reader');
    const writer = makeUser(h.db, 'usr_writer');
    createProfile(h.db, { id: 'full', name: 'Pełny', tools: [...KNOWN_MCP_TOOLS] });
    readKey = createKey(h.db, reader, 'read', ['read'], 'default', 30).raw;
    writeKey = createKey(h.db, writer, 'write', ['read', 'write'], 'full', 30).raw;
    readOnFullKey = createKey(h.db, reader, 'read-full', ['read'], 'full', 30).raw;
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('initialize → tools/list → kb_search → kb_answer (mock LLM przez DI) → kb_feedback', async () => {
    // 1. initialize
    const init = await mcpRequest(h.bundle.app, 'default', readKey, initializeBody());
    expect(init.statusCode).toBe(200);
    const initBody = init.json() as RpcEnvelope<{ serverInfo: { name: string } }>;
    expect(initBody.result.serverInfo.name).toBe('pomagierkb');

    // 2. tools/list == tools_json profilu default
    const list = await mcpRequest(h.bundle.app, 'default', readKey, toolsListBody());
    const names = (list.json() as RpcEnvelope<{ tools: { name: string }[] }>).result.tools.map(
      (t) => t.name,
    );
    expect(names).toEqual(['kb_search', 'kb_answer', 'kb_list', 'kb_get_source', 'kb_list_documents', 'kb_draft_status', 'kb_feedback']);

    // 3. kb_search — fallback FTS5 (openspg null) z degraded:true
    const search = await mcpRequest(
      h.bundle.app,
      'default',
      readKey,
      toolsCallBody('kb_search', { query: 'maksymalne obciążenie szynoprzewodów' }),
    );
    expect(search.statusCode).toBe(200);
    const searchRes = (search.json() as RpcEnvelope<CallResult>).result;
    expect(searchRes.isError).toBeUndefined();
    const searchOut = searchRes.structuredContent as {
      results: { id: string; namespace: string; source: string }[];
      degraded: boolean;
    };
    expect(searchOut.degraded).toBe(true);
    expect(searchOut.results[0]?.id).toBe('CHUNK_ld000001_001');
    expect(searchOut.results[0]?.source).toBe('fallback_fts');
    expect(searchRes.content[0]?.text).toContain('Montaż szynoprzewodów');

    // 4. kb_answer — mock LLM wstrzyknięty do fabryki przez llmProvider (DI)
    const answer = await mcpRequest(
      h.bundle.app,
      'default',
      readKey,
      toolsCallBody('kb_answer', { question: QUESTION }),
    );
    expect(answer.statusCode).toBe(200);
    const answerRes = (answer.json() as RpcEnvelope<CallResult>).result;
    expect(answerRes.isError).toBeUndefined();
    const answerOut = answerRes.structuredContent as {
      answer: string;
      citations: { n: number; id: string }[];
      confidence: number;
      gapRecorded: boolean;
      answerId: string;
    };
    expect(mock.calls.chat).toBe(1); // dowód: odpowiadał mock, nie prawdziwy LLM
    expect(answerOut.answer).toContain('[1]');
    expect(answerOut.citations[0]?.id).toBe('CHUNK_ld000001_001');
    expect(answerOut.confidence).toBeGreaterThan(0.45);
    expect(answerOut.gapRecorded).toBe(false);
    const answerRow = h.db
      .prepare('SELECT source FROM answers WHERE id = ?')
      .get(answerOut.answerId) as { source: string } | undefined;
    expect(answerRow?.source).toBe('mcp');

    // 5. kb_feedback kluczem READ (profil default „odczyt + feedback" — PLAN Faza 5)
    const fb = await mcpRequest(
      h.bundle.app,
      'default',
      readKey,
      toolsCallBody('kb_feedback', { answerId: answerOut.answerId, verdict: 'down' }),
    );
    const fbRes = (fb.json() as RpcEnvelope<CallResult>).result;
    expect(fbRes.isError).toBeUndefined();
    expect(fbRes.structuredContent).toMatchObject({ ok: true, gapCreated: true });
  });

  it('kb_submit_draft kluczem write → draft w DB (pending, source mcp, klucz autora)', async () => {
    const res = await mcpRequest(
      h.bundle.app,
      'full',
      writeKey,
      toolsCallBody('kb_submit_draft', {
        namespace: 'LightingDocs',
        title: 'Obciążalność szynoprzewodów',
        content: DRAFT_CONTENT,
        tags: ['szynoprzewody'],
      }),
    );
    expect(res.statusCode).toBe(200);
    const out = (res.json() as RpcEnvelope<CallResult>).result;
    expect(out.isError).toBeUndefined();
    const structured = out.structuredContent as {
      draftId: string;
      status: string;
      reviewRequired: boolean;
    };
    expect(structured.status).toBe('inbox');
    expect(structured.reviewRequired).toBe(true);

    // Weryfikacja w DB: pending, source_type mcp, autor = id klucza write, poza grafem
    const row = h.db
      .prepare(
        'SELECT namespace, status, source_type, submitted_by_key, title FROM drafts WHERE id = ?',
      )
      .get(structured.draftId) as {
      namespace: string;
      status: string;
      source_type: string;
      submitted_by_key: string | null;
      title: string;
    };
    expect(row).toMatchObject({
      namespace: 'LightingDocs',
      status: 'pending',
      source_type: 'mcp',
      title: 'Obciążalność szynoprzewodów',
    });
    const keyRow = h.db
      .prepare("SELECT id FROM api_keys WHERE label = 'write'")
      .get() as { id: string };
    expect(row.submitted_by_key).toBe(keyRow.id);

    // Audyt mutacji (checklista pkt 6): wpis mcp.submit_draft w łańcuchu
    const audit = h.db
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'mcp.submit_draft'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it('klucz read na kb_submit_draft → JSON-RPC -32003 (deny-by-default write)', async () => {
    const res = await mcpRequest(
      h.bundle.app,
      'full',
      readOnFullKey,
      toolsCallBody('kb_submit_draft', {
        namespace: 'LightingDocs',
        title: 'Nieuprawniony zapis',
        content: DRAFT_CONTENT,
      }),
    );
    const body = res.json() as { error?: { code: number } };
    expect(body.error?.code).toBe(-32003);
    // nic nie trafiło do inboxu
    const n = (h.db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number }).n;
    expect(n).toBe(0);
  });
});
