import { describe, expect, it } from 'vitest';
import { kbSubmitDraftTool } from '../src/tools/index.js';
import { makeCtx, seedKb, testDb } from './helpers-tools.js';

interface SubmitOut {
  draftId: string;
  status: string;
  reviewRequired: boolean;
  duplicate?: boolean;
}

const CONTENT =
  '# Szynoprzewody\n\nMaksymalne obciążenie toru trójfazowego wynosi 16 A na fazę. ' +
  'Przed montażem sprawdź nośność stropu i przekroje przewodów zasilających.';

describe('kb_submit_draft', () => {
  it('tworzy pending draft w Inboxie i wpis audytu mcp.submit_draft', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db, { scopes: ['read', 'write'] });

    const res = await kbSubmitDraftTool.handler(ctx, {
      namespace: 'LightingDocs',
      title: 'Szynoprzewody — obciążenia',
      content: CONTENT,
      sourceUrl: 'https://example.com/norma.pdf',
      tags: ['elektryka'],
    });
    expect(res.isError).toBeUndefined();
    const out = res.structured as SubmitOut;
    expect(out.draftId).toMatch(/^draft_/);
    expect(out.status).toBe('inbox');
    expect(out.reviewRequired).toBe(true);

    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(out.draftId) as {
      status: string;
      source_type: string;
      namespace: string;
      submitted_by_key: string;
      source_ref: string;
    };
    expect(draft.status).toBe('pending');
    expect(draft.source_type).toBe('mcp');
    expect(draft.namespace).toBe('LightingDocs');
    expect(draft.submitted_by_key).toBe(ctx.keyRow.id);
    expect(draft.source_ref).toBe('https://example.com/norma.pdf');

    const audit = db
      .prepare("SELECT * FROM audit WHERE action = 'mcp.submit_draft'")
      .all() as { actor: string; resource_id: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe(ctx.keyRow.id);
    expect(audit[0]?.resource_id).toBe(out.draftId);
  });

  it('duplikat treści (content_hash) zwraca istniejący draftId z adnotacją', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db, { scopes: ['read', 'write'] });

    const first = await kbSubmitDraftTool.handler(ctx, {
      namespace: 'LightingDocs',
      title: 'Szynoprzewody — obciążenia',
      content: CONTENT,
    });
    const second = await kbSubmitDraftTool.handler(ctx, {
      namespace: 'LightingDocs',
      title: 'Inny tytuł, ta sama treść',
      content: CONTENT,
    });
    const out1 = first.structured as SubmitOut;
    const out2 = second.structured as SubmitOut;
    expect(second.isError).toBeUndefined();
    expect(out2.draftId).toBe(out1.draftId);
    expect(out2.duplicate).toBe(true);
    expect(second.text).toContain('istniejący draft');

    const count = (db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('klucz bez scope write → odmowa (deny-by-default)', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db, { scopes: ['read'] });

    const res = await kbSubmitDraftTool.handler(ctx, {
      namespace: 'LightingDocs',
      title: 'Nieautoryzowany wpis',
      content: CONTENT,
    });
    expect(res.isError).toBe(true);
    expect((res.structured as { errorCode: string }).errorCode).toBe('forbidden');
    expect((db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number }).n).toBe(0);
  });

  it('namespace spoza profilu → namespace_not_allowed', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedKb(db, 'OtherDocs');
    const ctx = makeCtx(db, { namespaces: ['LightingDocs'], scopes: ['read', 'write'] });

    const res = await kbSubmitDraftTool.handler(ctx, {
      namespace: 'OtherDocs',
      title: 'Wpis do cudzej bazy',
      content: CONTENT,
    });
    expect(res.isError).toBe(true);
    expect((res.structured as { errorCode: string }).errorCode).toBe('namespace_not_allowed');
  });
});
