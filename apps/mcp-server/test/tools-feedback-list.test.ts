import { describe, expect, it } from 'vitest';
import { finishExportRun, recordAnswer, startExportRun } from '@pomagierkb/shared/db';
import type { Db } from '@pomagierkb/shared/db';
import { kbFeedbackTool, kbListTool } from '../src/tools/index.js';
import { makeCtx, seedKb, testDb } from './helpers-tools.js';

function seedAnswer(db: Db): string {
  return recordAnswer(db, {
    question: 'Jakie jest maksymalne obciążenie szynoprzewodów?',
    namespaces: ['LightingDocs'],
    citations: [{ n: 1, id: 'LightingDocs:Chunk:1', namespace: 'LightingDocs' }],
    confidence: 0.9,
    source: 'mcp',
  }).id;
}

describe('kb_feedback', () => {
  it('verdict down tworzy lukę wiedzy (source feedback)', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db);
    const answerId = seedAnswer(db);

    const res = await kbFeedbackTool.handler(ctx, {
      answerId,
      verdict: 'down',
      comment: 'Odpowiedź pomija warunki montażu.',
    });
    expect(res.isError).toBeUndefined();
    expect(res.structured).toEqual({ ok: true, gapCreated: true });

    const gap = db.prepare("SELECT * FROM learning_gaps WHERE source = 'feedback'").get() as {
      question: string;
      status: string;
      kb_namespace: string;
    };
    expect(gap.question).toBe('Jakie jest maksymalne obciążenie szynoprzewodów?');
    expect(gap.status).toBe('open');
    expect(gap.kb_namespace).toBe('LightingDocs');
  });

  it('verdict up nie tworzy luki', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db);
    const answerId = seedAnswer(db);

    const res = await kbFeedbackTool.handler(ctx, { answerId, verdict: 'up' });
    expect(res.structured).toEqual({ ok: true, gapCreated: false });
    const gaps = (db.prepare('SELECT COUNT(*) AS n FROM learning_gaps').get() as { n: number }).n;
    expect(gaps).toBe(0);
  });

  it('nieistniejący answerId → błąd validation', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    const ctx = makeCtx(db);

    const res = await kbFeedbackTool.handler(ctx, { answerId: 'ans_nie_ma', verdict: 'down' });
    expect(res.isError).toBe(true);
    expect((res.structured as { errorCode: string }).errorCode).toBe('validation');
  });
});

interface ListOut {
  kbs: { namespace: string; name: string; status: string; documentCount?: number }[];
}

describe('kb_list', () => {
  it('przycina rejestr do namespaces profilu i dokleja documentCount z manifestów', async () => {
    const db = testDb();
    seedKb(db, 'AlphaDocs');
    seedKb(db, 'BetaDocs');
    const run = startExportRun(db, 'AlphaDocs');
    finishExportRun(db, run.id, 'success', { docCount: 3, chunkCount: 9 });
    const ctx = makeCtx(db, { namespaces: ['AlphaDocs'] });

    const res = await kbListTool.handler(ctx, {});
    expect(res.isError).toBeUndefined();
    const out = res.structured as ListOut;
    expect(out.kbs).toHaveLength(1);
    expect(out.kbs[0]?.namespace).toBe('AlphaDocs');
    expect(out.kbs[0]?.status).toBe('active');
    expect(out.kbs[0]?.documentCount).toBe(3);
    expect(res.text).toContain('AlphaDocs');
    expect(res.text).not.toContain('BetaDocs');
  });

  it('bez ograniczenia profilu zwraca wszystkie aktywne KB', async () => {
    const db = testDb();
    seedKb(db, 'AlphaDocs');
    seedKb(db, 'BetaDocs');
    const ctx = makeCtx(db);

    const res = await kbListTool.handler(ctx, {});
    const out = res.structured as ListOut;
    expect(out.kbs.map((k) => k.namespace).sort()).toEqual(['AlphaDocs', 'BetaDocs']);
  });
});
