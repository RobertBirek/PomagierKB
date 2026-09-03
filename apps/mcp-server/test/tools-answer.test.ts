import { beforeEach, describe, expect, it } from 'vitest';
import { clearAnswerCache } from '@pomagierkb/shared/answer';
import { kbAnswerTool } from '../src/tools/index.js';
import { makeCtx, mockLlm, seedKb, seedLightingChunks, testDb } from './helpers-tools.js';

interface AnswerOut {
  answer: string;
  citations: { n: number; id: string; namespace: string; title?: string }[];
  confidence: number;
  degraded: boolean;
  gapRecorded: boolean;
  noAnswer: boolean;
  answerId: string;
  warnings: string[];
}

// Uwaga: buildMatchExpression łączy tokeny AND-em, więc pytanie testowe nie może
// zawierać słów nieobecnych w treści chunka (stopwordy typu „jakie jest" ubiją FTS).
const QUESTION = 'Maksymalne obciążenie szynoprzewodów przy montażu?';

function gapCount(db: ReturnType<typeof testDb>): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM learning_gaps').get() as { n: number }).n;
}

describe('kb_answer', () => {
  beforeEach(() => clearAnswerCache()); // cache odpowiedzi jest per proces

  it('happy path: odpowiedź z cytowaniem [1], answerId i zapisem do answers', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedLightingChunks(db);
    const mock = mockLlm();
    const ctx = makeCtx(db, { llm: mock.llm });

    const res = await kbAnswerTool.handler(ctx, { question: QUESTION });
    expect(res.isError).toBeUndefined();
    const out = res.structured as AnswerOut;
    expect(out.noAnswer).toBe(false);
    expect(out.answer).toContain('[1]');
    expect(out.answerId).toMatch(/^ans_/);
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]?.n).toBe(1);
    expect(out.citations[0]?.id).toBe('CHUNK_ld000001_001');
    expect(out.citations[0]?.namespace).toBe('LightingDocs');
    // confidence = 0.5*0.8 (llmSelf) + 0.3*1 (topNorm) + 0.2*1 (coverage) = 0.9 > próg 0.45
    expect(out.confidence).toBeCloseTo(0.9, 5);
    expect(out.gapRecorded).toBe(false);
    expect(mock.calls.chat).toBe(1);
    expect(mock.calls.embed).toBe(0); // openspg null → kanał wektorowy pominięty

    const row = db.prepare('SELECT * FROM answers WHERE id = ?').get(out.answerId) as {
      no_answer: number;
      source: string;
      question: string;
    };
    expect(row.no_answer).toBe(0);
    expect(row.source).toBe('mcp');
    expect(row.question).toBe(QUESTION);
    expect(gapCount(db)).toBe(0);
    expect(res.text).toContain('Źródła');
  });

  it('bramka odmowy: brak wyników → NO_ANSWER, gap zapisany, chat_llm NIE wywołany', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedLightingChunks(db);
    const mock = mockLlm();
    const ctx = makeCtx(db, { llm: mock.llm });

    const res = await kbAnswerTool.handler(ctx, { question: 'Ile kosztuje bilet miesięczny w Krakowie?' });
    expect(res.isError).toBeUndefined();
    const out = res.structured as AnswerOut;
    expect(out.noAnswer).toBe(true);
    expect(out.answer).toMatch(/^Nie znalazłem tego w bazie wiedzy/);
    expect(out.citations).toHaveLength(0);
    expect(out.confidence).toBe(0);
    expect(out.gapRecorded).toBe(true);
    expect(mock.calls.chat).toBe(0); // ZERO kosztu LLM przy odmowie

    const gap = db.prepare("SELECT * FROM learning_gaps WHERE source = 'mcp'").get() as {
      question: string;
      status: string;
    };
    expect(gap.question).toBe('Ile kosztuje bilet miesięczny w Krakowie?');
    expect(gap.status).toBe('open');
    const answerRow = db.prepare('SELECT no_answer FROM answers WHERE id = ?').get(out.answerId) as {
      no_answer: number;
    };
    expect(answerRow.no_answer).toBe(1);
  });

  it('cytowanie-halucynacja [9] jest usuwane, prawidłowe [1] zostaje', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedLightingChunks(db);
    const mock = mockLlm('Zgodnie ze źródłem [1] oraz [9] obciążenie wynosi 16 A.\nCONFIDENCE: 0.9');
    const ctx = makeCtx(db, { llm: mock.llm });

    const res = await kbAnswerTool.handler(ctx, { question: QUESTION });
    const out = res.structured as AnswerOut;
    expect(out.answer).toContain('[1]');
    expect(out.answer).not.toContain('[9]');
    expect(out.citations.map((c) => c.n)).toEqual([1]);
    expect(out.warnings.join(' ')).toContain('[9]');
  });

  it('brak jakiegokolwiek cytowania → confidence obniżone o połowę i luka wiedzy', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedLightingChunks(db);
    const mock = mockLlm('Nie mam pewności co do odpowiedzi.\nCONFIDENCE: 0.8');
    const ctx = makeCtx(db, { llm: mock.llm });

    const res = await kbAnswerTool.handler(ctx, { question: QUESTION });
    const out = res.structured as AnswerOut;
    // (0.5*0.8 + 0.3*1 + 0.2*0) * 0.5 = 0.35 < 0.45 → gap
    expect(out.confidence).toBeCloseTo(0.35, 5);
    expect(out.gapRecorded).toBe(true);
    expect(gapCount(db)).toBe(1);
  });

  it('llm null → błąd upstream_unavailable (bez wyjątku protokołu)', async () => {
    const db = testDb();
    seedKb(db, 'LightingDocs');
    seedLightingChunks(db);
    const ctx = makeCtx(db); // llm: null

    const res = await kbAnswerTool.handler(ctx, { question: QUESTION });
    expect(res.isError).toBe(true);
    expect((res.structured as { errorCode: string }).errorCode).toBe('upstream_unavailable');
  });
});
