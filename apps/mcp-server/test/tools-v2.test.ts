import { describe, expect, it } from 'vitest';
import { createDraft, replaceForDocument } from '@pomagierkb/shared/db';
import {
  kbDraftStatusTool,
  kbGetSourceTool,
  kbListDocumentsTool,
} from '../src/tools/index.js';
import { makeCtx, seedKb, seedLightingChunks, testDb } from './helpers-tools.js';

/** Testy narzędzi MCP v2: kb_get_source / kb_list_documents / kb_draft_status. */

interface SourceOut {
  id: string;
  docId: string;
  namespace: string;
  title?: string;
  content: string;
  truncated: boolean;
  nextChunkId?: string;
  prevChunkId?: string;
  chunkCount: number;
}

describe('kb_get_source', () => {
  it('CHUNK_* zwraca pełną treść + sąsiadów z sufiksu _NNN', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db);
    replaceForDocument(db, 'LightingDocs', 'DOC_x1', [
      { id: 'CHUNK_x1_001', title: 'Dok', sectionHeading: 'Wstęp', content: 'Pierwsza sekcja.' },
      { id: 'CHUNK_x1_002', title: 'Dok', sectionHeading: 'Montaż', content: 'Druga sekcja o montażu.' },
      { id: 'CHUNK_x1_003', title: 'Dok', content: 'Trzecia sekcja.' },
    ]);

    const res = await kbGetSourceTool.handler(ctx, { id: 'CHUNK_x1_002' });
    expect(res.isError).toBeUndefined();
    const out = res.structured as SourceOut;
    expect(out.content).toBe('Druga sekcja o montażu.');
    expect(out.docId).toBe('DOC_x1');
    expect(out.prevChunkId).toBe('CHUNK_x1_001');
    expect(out.nextChunkId).toBe('CHUNK_x1_003');
    expect(out.chunkCount).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it('DOC_* skleja sekcje z nagłówkami; maxChars → truncated + nextChunkId', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db);
    replaceForDocument(db, 'LightingDocs', 'DOC_x2', [
      { id: 'CHUNK_x2_001', title: 'Dok2', sectionHeading: 'A', content: 'a'.repeat(800) },
      { id: 'CHUNK_x2_002', title: 'Dok2', sectionHeading: 'B', content: 'b'.repeat(800) },
    ]);

    const full = (await kbGetSourceTool.handler(ctx, { id: 'DOC_x2' })).structured as SourceOut;
    expect(full.truncated).toBe(false);
    expect(full.content).toContain('## A');
    expect(full.content).toContain('## B');
    expect(full.chunkCount).toBe(2);

    const cut = (await kbGetSourceTool.handler(ctx, { id: 'DOC_x2', maxChars: 1000 }))
      .structured as SourceOut;
    expect(cut.truncated).toBe(true);
    expect(cut.nextChunkId).toBe('CHUNK_x2_002');
    expect(cut.content).not.toContain('## B');
  });

  it('ACL: namespace spoza profilu i nieistniejący id → ten sam błąd (bez wyroczni)', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedKb(db, 'SecretDocs');
    seedLightingChunks(db);
    replaceForDocument(db, 'SecretDocs', 'DOC_s1', [
      { id: 'CHUNK_s1_001', content: 'Tajne dane.' },
    ]);
    const ctx = makeCtx(db, { namespaces: ['LightingDocs'] });

    const foreign = await kbGetSourceTool.handler(ctx, { id: 'CHUNK_s1_001' });
    const missing = await kbGetSourceTool.handler(ctx, { id: 'CHUNK_nope_001' });
    expect(foreign.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect((foreign.structured as { errorCode: string }).errorCode).toBe('validation');
    expect((missing.structured as { errorCode: string }).errorCode).toBe('validation');
    expect(foreign.text.replace('CHUNK_s1_001', 'X')).toBe(missing.text.replace('CHUNK_nope_001', 'X'));
  });
});

describe('kb_list_documents', () => {
  it('agreguje po doc_id z filtrem q i paginacją', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db);
    seedLightingChunks(db); // doc1: 2 chunki
    replaceForDocument(db, 'LightingDocs', 'DOC_extra', [
      { id: 'CHUNK_ex_001', title: 'Cennik opraw', content: 'Ceny hurtowe opraw LED.' },
    ]);

    const all = (await kbListDocumentsTool.handler(ctx, { namespace: 'LightingDocs' }))
      .structured as { documents: { docId: string; chunks: number }[]; total: number };
    expect(all.total).toBe(2);
    const byId = new Map(all.documents.map((d) => [d.docId, d.chunks]));
    expect(byId.get('doc1')).toBe(2);
    expect(byId.get('DOC_extra')).toBe(1);

    const filtered = (
      await kbListDocumentsTool.handler(ctx, { namespace: 'LightingDocs', q: 'Cennik' })
    ).structured as { total: number };
    expect(filtered.total).toBe(1);
  });

  it('namespace spoza profilu → namespace_not_allowed', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db, { namespaces: ['LightingDocs'] });
    const res = await kbListDocumentsTool.handler(ctx, { namespace: 'InnaBaza' });
    expect(res.isError).toBe(true);
    expect((res.structured as { errorCode: string }).errorCode).toBe('namespace_not_allowed');
  });
});

describe('kb_draft_status', () => {
  it('pokazuje wyłącznie drafty własnego klucza (+liczniki); cudzy draftId → błąd', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctxA = makeCtx(db);
    const ctxB = makeCtx(db);
    const mine = createDraft(db, {
      title: 'Lekcja o DALI',
      content: 'Treść lekcji o sterowaniu DALI w projektach.',
      sourceType: 'mcp',
      namespace: 'LightingDocs',
      submittedByKey: ctxA.keyRow.id,
    });
    createDraft(db, {
      title: 'Cudzy draft',
      content: 'Treść cudzego draftu innego klucza.',
      sourceType: 'mcp',
      namespace: 'LightingDocs',
      submittedByKey: ctxB.keyRow.id,
    });

    const list = (await kbDraftStatusTool.handler(ctxA, {})).structured as {
      drafts: { draftId: string }[];
      counts: { pending: number };
    };
    expect(list.drafts).toHaveLength(1);
    expect(list.drafts[0]?.draftId).toBe(mine.id);
    expect(list.counts.pending).toBe(1);

    const one = await kbDraftStatusTool.handler(ctxA, { draftId: mine.id });
    expect(one.isError).toBeUndefined();

    const foreign = await kbDraftStatusTool.handler(ctxB, { draftId: mine.id });
    expect(foreign.isError).toBe(true);
    expect((foreign.structured as { errorCode: string }).errorCode).toBe('validation');
  });
});
