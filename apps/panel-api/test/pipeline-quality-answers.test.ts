import { describe, expect, it } from 'vitest';
import { computeAnswerQuality, type AnswerSample } from '../src/pipeline/quality-answers.js';

/** Agregacja jakości odpowiedzi (F10.2) — pure. */

function sample(over: Partial<AnswerSample> = {}): AnswerSample {
  return { namespace: 'Kb', confidence: 0.8, degraded: false, noAnswer: false, tookMs: 1000, ...over };
}

describe('computeAnswerQuality', () => {
  it('liczy metryki: odmowy, degradacje, histogram, percentyle, usage', () => {
    const m = computeAnswerQuality({
      answers: [
        sample({ confidence: 0.9, tookMs: 500 }),
        sample({ confidence: 0.6, tookMs: 1500 }),
        sample({ confidence: 0.2, tookMs: 3000, degraded: true }),
        sample({ noAnswer: true, confidence: null, tookMs: 100 }),
      ],
      feedback: [{ verdict: 'up' }, { verdict: 'down' }],
      openGaps: 3,
      topGapEvidence: [{ question: 'Q1?', evidence: 5 }],
      usage: [
        { keyId: 'k1', tool: 'kb_answer' },
        { keyId: 'k1', tool: 'kb_search' },
        { keyId: 'k2', tool: 'kb_search' },
      ],
    });
    expect(m.answers).toBe(4);
    expect(m.noAnswerRate).toBeCloseTo(0.25);
    expect(m.degradedRate).toBeCloseTo(0.25);
    expect(m.confidenceHistogram).toEqual({ lt03: 1, lt05: 0, lt07: 1, gte07: 1 });
    expect(m.p50TookMs).toBe(500);
    expect(m.p95TookMs).toBe(3000);
    expect(m.feedback.downRate).toBeCloseTo(0.5);
    expect(m.usage.byTool['kb_search']).toBe(2);
    expect(m.usage.byKey['k1']).toBe(2);
    expect(m.openGaps).toBe(3);
  });

  it('werdykty: OK poniżej progów; WARN >30% odmów; FAIL >50% odmów lub >40% 👎', () => {
    const ok = computeAnswerQuality({
      answers: [sample(), sample(), sample(), sample({ noAnswer: true, confidence: null })],
      feedback: [{ verdict: 'up' }, { verdict: 'up' }, { verdict: 'up' }, { verdict: 'up' }, { verdict: 'down' }],
      openGaps: 0, topGapEvidence: [], usage: [],
    });
    expect(ok.verdict).toBe('OK');

    const warn = computeAnswerQuality({
      answers: [
        sample(), sample(), sample(),
        sample({ noAnswer: true, confidence: null }),
        sample({ noAnswer: true, confidence: null }),
      ], // 2/5 = 40% odmów — w oknie (30%, 50%]
      feedback: [], openGaps: 0, topGapEvidence: [], usage: [],
    });
    expect(warn.verdict).toBe('WARN');
    expect(warn.verdictReasons[0]).toContain('odmów');

    const fail = computeAnswerQuality({
      answers: [sample({ noAnswer: true, confidence: null }), sample({ noAnswer: true, confidence: null }), sample()],
      feedback: [{ verdict: 'down' }, { verdict: 'down' }, { verdict: 'up' }],
      openGaps: 0, topGapEvidence: [], usage: [],
    });
    expect(fail.verdict).toBe('FAIL');
  });

  it('puste okno: n=0 → wskaźniki null, werdykt OK', () => {
    const m = computeAnswerQuality({ answers: [], feedback: [], openGaps: 0, topGapEvidence: [], usage: [] });
    expect(m.answers).toBe(0);
    expect(m.noAnswerRate).toBeNull();
    expect(m.verdict).toBe('OK');
  });
});
