import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKey, createProfile } from '@pomagierkb/shared/db';
import {
  makeHarness,
  makeUser,
  mcpRequest,
  toolsCallBody,
  toolsListBody,
  type TestHarness,
} from './helpers.js';

/** Auth Bearer: 401/403, audyt mcp.auth_failed (tylko prefix!), write-gate -32003. */

interface AuditRow {
  actor: string;
  action: string;
  outcome: string;
  metadata_json: string | null;
}

function auditRows(h: TestHarness): AuditRow[] {
  return h.db
    .prepare("SELECT actor, action, outcome, metadata_json FROM audit WHERE action = 'mcp.auth_failed' ORDER BY seq")
    .all() as AuditRow[];
}

describe('shell MCP: auth', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('brak nagłówka Authorization → 401 JSON-RPC -32001 + audyt', async () => {
    const res = await mcpRequest(h.bundle.app, 'default', null, toolsListBody());
    expect(res.statusCode).toBe(401);
    const body = res.json() as { jsonrpc: string; error: { code: number; message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe('unauthorized');
    const rows = auditRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('failure');
    expect(rows[0]!.actor).toBe('(brak)');
  });

  it('zły klucz → 401; w audycie WYŁĄCZNIE prefix tokenu', async () => {
    const fake = 'sk-ZupelnieZmyslonyKluczKtoregoNieMaWBazie123'; // gitleaks:allow — celowo zmyślony klucz testowy
    const res = await mcpRequest(h.bundle.app, 'default', fake, toolsListBody());
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: number } }).error.code).toBe(-32001);
    const rows = auditRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(fake.slice(0, 6));
    // pełny token NIGDY nie trafia do audytu
    const all = JSON.stringify(rows);
    expect(all).not.toContain(fake);
  });

  it('klucz przypisany do innego profilu → 403', async () => {
    const userId = makeUser(h.db);
    createProfile(h.db, { id: 'other', name: 'Other', tools: ['kb_list'] });
    const raw = createKey(h.db, userId, 'k', ['read'], 'default', 30).raw;
    const res = await mcpRequest(h.bundle.app, 'other', raw, toolsListBody());
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: number } }).error.code).toBe(-32003);
    const rows = auditRows(h);
    expect(rows[0]!.metadata_json).toContain('profile_mismatch');
  });

  it('klucz użytkownika disabled → 401', async () => {
    const userId = makeUser(h.db, 'usr_off');
    const raw = createKey(h.db, userId, 'k', ['read'], 'default', 30).raw;
    h.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(userId);
    const res = await mcpRequest(h.bundle.app, 'default', raw, toolsListBody());
    expect(res.statusCode).toBe(401);
  });

  it('write-gate: klucz read na narzędziu write → JSON-RPC -32003', async () => {
    const userId = makeUser(h.db);
    createProfile(h.db, { id: 'writer', name: 'Writer', tools: ['kb_list', 'kb_submit_draft'] });
    const readKey = createKey(h.db, userId, 'r', ['read'], 'writer', 30).raw;
    const res = await mcpRequest(h.bundle.app, 'writer', readKey, toolsCallBody('kb_submit_draft'));
    expect(res.statusCode).toBe(200); // błąd na poziomie JSON-RPC, nie HTTP
    const body = res.json() as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32003);
    expect(body.error.message).toContain('write');
    // narzędzia read działają tym samym kluczem
    const ok = await mcpRequest(h.bundle.app, 'writer', readKey, toolsCallBody('kb_list'));
    expect((ok.json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });
});
