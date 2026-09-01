import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KNOWN_MCP_TOOLS, createKey, createProfile, getProfile } from '@pomagierkb/shared/db';
import { ALL_TOOLS } from '../src/tools/index.js';
import { makeHarness, makeUser, mcpRequest, toolsListBody, type TestHarness } from './helpers.js';

/**
 * TEST KONTRAKTOWY (backend-mcp §7.3/§7.4, PLAN Faza 5 pkt 3):
 * 1. dla KAŻDEGO profilu w DB (seed migracji + profile dodane w teście)
 *    tools/list == tools_json profilu — dokładnie, łącznie z kolejnością rejestru;
 * 2. schematy narzędzi zgodne z §7.4: inputSchema z additionalProperties:false
 *    i dokładnym required; adnotacje read-only dla search/answer/list.
 */

/** DOKŁADNE required z docs/design/backend-mcp.md §7.4 (kb_feedback wg PLAN Faza 5 pkt 4). */
const REQUIRED_INPUT: Record<string, string[]> = {
  kb_search: ['query'],
  kb_answer: ['question'],
  kb_list: [],
  kb_submit_draft: ['namespace', 'title', 'content'],
  kb_feedback: ['answerId', 'verdict'],
};

const REQUIRED_OUTPUT: Record<string, string[]> = {
  kb_search: ['results', 'degraded'],
  kb_answer: ['answer', 'citations', 'confidence', 'gapRecorded'],
  kb_list: ['kbs'],
  kb_submit_draft: ['draftId', 'status', 'reviewRequired'],
  kb_feedback: ['ok', 'gapCreated'],
};

interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type?: string; additionalProperties?: unknown; required?: string[] };
  outputSchema: { required?: string[] };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

describe('kontrakt: tools/list == tools_json profilu (dla każdego profilu z DB)', () => {
  let h: TestHarness;

  beforeEach(() => {
    // PRAWDZIWE narzędzia (nie stuby) — kontrakt dotyczy produkcyjnego rejestru.
    h = makeHarness({ tools: ALL_TOOLS });
    // Obok seedowanego 'default': profil pełny (w tym write) i zawężony, w innej kolejności.
    createProfile(h.db, { id: 'full', name: 'Pełny', tools: [...KNOWN_MCP_TOOLS] });
    createProfile(h.db, { id: 'narrow', name: 'Zawężony', tools: ['kb_list', 'kb_search'] });
  });

  afterEach(async () => {
    await h.cleanup();
  });

  function allProfileIds(): string[] {
    return (h.db.prepare('SELECT id FROM mcp_profiles WHERE enabled = 1 ORDER BY id').all() as {
      id: string;
    }[]).map((r) => r.id);
  }

  it('seed migracji zawiera profil default (odczyt + feedback, bez write)', () => {
    const row = getProfile(h.db, 'default');
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.tools_json)).toEqual(['kb_search', 'kb_answer', 'kb_list', 'kb_feedback']);
  });

  it('rejestr ALL_TOOLS pokrywa się 1:1 z whitelistą KNOWN_MCP_TOOLS', () => {
    expect(ALL_TOOLS.map((t) => t.name)).toEqual([...KNOWN_MCP_TOOLS]);
  });

  it('tools/list == tools_json — dla każdego profilu z DB', async () => {
    const ids = allProfileIds();
    expect(ids).toContain('default'); // seed migracji obecny
    for (const profileId of ids) {
      const userId = makeUser(h.db, `usr_${profileId}`);
      const raw = createKey(h.db, userId, `k-${profileId}`, ['read'], profileId, 30).raw;
      const res = await mcpRequest(h.bundle.app, profileId, raw, toolsListBody());
      expect(res.statusCode).toBe(200);
      const listed = (res.json() as { result: { tools: ListedTool[] } }).result.tools.map(
        (t) => t.name,
      );
      const declared = JSON.parse(
        (h.db.prepare('SELECT tools_json FROM mcp_profiles WHERE id = ?').get(profileId) as {
          tools_json: string;
        }).tools_json,
      ) as string[];
      // ta sama zawartość (kolejność listy = kolejność rejestru ALL_TOOLS)
      expect([...listed].sort()).toEqual([...declared].sort());
      expect(new Set(listed).size).toBe(listed.length); // bez duplikatów
    }
  });

  it('schematy §7.4: additionalProperties:false + dokładne required na wejściu i wyjściu', async () => {
    const userId = makeUser(h.db, 'usr_schema');
    const raw = createKey(h.db, userId, 'k-schema', ['read'], 'full', 30).raw;
    const res = await mcpRequest(h.bundle.app, 'full', raw, toolsListBody());
    const tools = (res.json() as { result: { tools: ListedTool[] } }).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...KNOWN_MCP_TOOLS].sort());

    for (const tool of tools) {
      // §7.4 / checklista pkt 5: mass assignment — additionalProperties:false na KAŻDYM wejściu
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required ?? []).toEqual(REQUIRED_INPUT[tool.name]);
      expect(tool.outputSchema.required).toEqual(expect.arrayContaining(REQUIRED_OUTPUT[tool.name]!));
    }
  });

  it('adnotacje §7.4: search/answer/list read-only+idempotent, submit_draft nie-destruktywny zapis', async () => {
    const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
    for (const name of ['kb_search', 'kb_answer', 'kb_list'] as const) {
      expect(byName.get(name)!.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    const submit = byName.get('kb_submit_draft')!;
    expect(submit.annotations.readOnlyHint).toBe(false);
    expect(submit.annotations.destructiveHint).toBe(false);
    expect(submit.requiresWriteScope).toBe(true);
    // PLAN Faza 5: feedback dostępny dla kluczy read (profil default) — jawny wyjątek
    expect(byName.get('kb_feedback')!.requiresWriteScope).toBe(false);
  });
});
