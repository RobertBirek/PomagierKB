import { describe, expect, it } from 'vitest';
import { replaceEdgesForNamespace, replaceForDocument } from '@pomagierkb/shared/db';
import { sanitizeEntityProperties } from '@pomagierkb/shared/openspg';
import {
  kbEntityGetTool,
  kbGraphNeighborsTool,
  kbSubmitDraftTool,
} from '../src/tools/index.js';
import { makeCtx, seedKb, testDb } from './helpers-tools.js';

/** Modernizacja MCP: kb_entity_get / kb_graph_neighbors / idempotencyKey. */

function seedGraph(db: ReturnType<typeof testDb>): void {
  replaceForDocument(db, 'LightingDocs', 'DOC_g1', [
    { id: 'CHUNK_g1_001', title: 'Karta HighBay', content: 'Strumień 21000 lm.' },
    { id: 'CHUNK_g1_002', title: 'Karta HighBay', content: 'Sterowanie DALI-2.' },
  ]);
  replaceEdgesForNamespace(db, 'LightingDocs', [
    { srcId: 'CHUNK_g1_001', rel: 'in_document', dstId: 'DOC_g1' },
    { srcId: 'CHUNK_g1_002', rel: 'in_document', dstId: 'DOC_g1' },
    { srcId: 'DOC_g1', rel: 'about_topic', dstId: 'TOPIC_HIGHBAY' },
  ]);
}

describe('sanitizeEntityProperties (quirki serwera OpenSPG)', () => {
  it('odcina pola wektorowe/underscore i literalne cudzysłowy', () => {
    expect(
      sanitizeEntityProperties({
        name: '"Oprawa HighBay"',
        sectionOrder: '"0"',
        _content_vector: [0.1, 0.2],
        _name_vector: [0.3],
        plain: 'bez zmian',
        num: 7,
      }),
    ).toEqual({ name: 'Oprawa HighBay', sectionOrder: '0', plain: 'bez zmian', num: '7' });
  });
});

describe('kb_graph_neighbors', () => {
  it('BFS z tytułami z mirrora; depth 2 dosięga tematu', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedGraph(db);
    const ctx = makeCtx(db);

    const res = await kbGraphNeighborsTool.handler(ctx, { id: 'CHUNK_g1_001', depth: 2 });
    expect(res.isError).toBeUndefined();
    const out = res.structured as {
      nodes: { id: string; distance: number; kind: string; title?: string }[];
      edges: { srcId: string; rel: string; dstId: string }[];
    };
    expect(out.nodes.map((n) => n.id)).toEqual(['DOC_g1', 'CHUNK_g1_002', 'TOPIC_HIGHBAY']);
    expect(out.nodes[0]).toMatchObject({ kind: 'document', title: 'Karta HighBay' });
    expect(out.edges.some((e) => e.rel === 'about_topic')).toBe(true);
  });

  it('ACL: encja spoza profilu / nieistniejąca → validation (bez wyroczni)', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedKb(db, 'SecretDocs');
    seedGraph(db);
    replaceEdgesForNamespace(db, 'SecretDocs', [
      { srcId: 'CHUNK_s_001', rel: 'in_document', dstId: 'DOC_s' },
    ]);
    const ctx = makeCtx(db, { namespaces: ['LightingDocs'] });

    const foreign = await kbGraphNeighborsTool.handler(ctx, { id: 'CHUNK_s_001' });
    const missing = await kbGraphNeighborsTool.handler(ctx, { id: 'CHUNK_nope_001' });
    expect(foreign.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect((foreign.structured as { errorCode: string }).errorCode).toBe('validation');
  });
});

describe('kb_entity_get', () => {
  it('fallback do mirrora (openspg=null) z degraded:true; chunk i dokument', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedGraph(db);
    const ctx = makeCtx(db); // openspg: null w helpers

    const chunk = await kbEntityGetTool.handler(ctx, { id: 'CHUNK_g1_001' });
    expect(chunk.isError).toBeUndefined();
    const cOut = chunk.structured as { spgType: string; degraded: boolean; properties: Record<string, string> };
    expect(cOut.spgType).toBe('LightingDocs.Chunk');
    expect(cOut.degraded).toBe(true);
    expect(cOut.properties['sourceDocumentRefId']).toBe('DOC_g1');

    const doc = await kbEntityGetTool.handler(ctx, { id: 'DOC_g1' });
    const dOut = doc.structured as { spgType: string; properties: Record<string, string> };
    expect(dOut.spgType).toBe('LightingDocs.ReferenceDocument');
    expect(dOut.properties['chunkCount']).toBe('2');
  });

  it('primary przez query/spgType, gdy openspg dostępny (mock) — bez degraded', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedGraph(db);
    db.prepare('UPDATE kb_registry SET project_id = 7 WHERE namespace = ?').run('LightingDocs');
    const ctx = makeCtx(db);
    ctx.openspg = {
      request: async (path: string) => {
        expect(path).toBe('/public/v1/query/spgType');
        return [
          {
            id: 'CHUNK_g1_001',
            spgType: 'LightingDocs.Chunk',
            properties: { name: '"Karta HighBay"', _content_vector: [0.1], content: '"Strumień 21000 lm."' },
          },
        ];
      },
    } as never;

    const res = await kbEntityGetTool.handler(ctx, { id: 'CHUNK_g1_001' });
    const out = res.structured as { degraded: boolean; properties: Record<string, string> };
    expect(out.degraded).toBe(false);
    expect(out.properties['name']).toBe('Karta HighBay');
    expect(out.properties['_content_vector']).toBeUndefined();
  });
});

describe('kb_submit_draft idempotencyKey', () => {
  it('retry z tym samym kluczem → ten sam draftId (duplicate:true), nawet przy INNEJ treści', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db, { scopes: ['read', 'write'] });
    const base = {
      namespace: 'LightingDocs',
      title: 'Lekcja o zawiesiach',
      idempotencyKey: 'idem-test-123456', // gitleaks:allow (testowy klucz idempotencji, nie sekret)
    };
    const first = await kbSubmitDraftTool.handler(ctx, {
      ...base,
      content: 'Pierwsza wersja treści lekcji o montażu zawiesi w halach.',
    });
    expect(first.isError).toBeUndefined();
    const firstId = (first.structured as { draftId: string }).draftId;

    const retry = await kbSubmitDraftTool.handler(ctx, {
      ...base,
      content: 'INNA treść po retry — nie powinna utworzyć nowego draftu.',
    });
    const out = retry.structured as { draftId: string; duplicate?: boolean };
    expect(out.draftId).toBe(firstId);
    expect(out.duplicate).toBe(true);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number }).n;
    expect(count).toBe(1);
  });
});
