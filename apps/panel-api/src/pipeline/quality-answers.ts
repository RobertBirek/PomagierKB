/**
 * Agregacja jakości odpowiedzi z PRODUKCYJNEGO korpusu (Etap: program ewaluacji
 * F10) — CZYSTA logika liczenia metryk + werdyktu; job jobs/quality-answers.ts
 * dostarcza dane (answers/feedback/learning_gaps z 7 dni + usage-JSONL MCP,
 * który dotąd był pisany i NIGDY nie czytany).
 */

export interface AnswerSample {
  namespace: string | null;
  confidence: number | null;
  degraded: boolean;
  noAnswer: boolean;
  tookMs: number | null;
}

export interface FeedbackSample {
  verdict: 'up' | 'down';
}

export interface UsageSample {
  keyId: string;
  tool: string;
  tookMs?: number;
}

export interface AnswerQualityMetrics {
  answers: number;
  noAnswerRate: number | null;
  degradedRate: number | null;
  avgConfidence: number | null;
  confidenceHistogram: { lt03: number; lt05: number; lt07: number; gte07: number };
  p50TookMs: number | null;
  p95TookMs: number | null;
  feedback: { up: number; down: number; downRate: number | null };
  openGaps: number;
  topGapEvidence: { question: string; evidence: number }[];
  usage: { calls: number; byTool: Record<string, number>; byKey: Record<string, number> };
  verdict: 'OK' | 'WARN' | 'FAIL';
  verdictReasons: string[];
}

/** Progi werdyktu (plan F10.2): no_answer>30% / down-rate>20% → WARN; oba lub >50%/>40% → FAIL. */
const NO_ANSWER_WARN = 0.3;
const NO_ANSWER_FAIL = 0.5;
const DOWN_WARN = 0.2;
const DOWN_FAIL = 0.4;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(idx, 0)] ?? null;
}

export function computeAnswerQuality(input: {
  answers: AnswerSample[];
  feedback: FeedbackSample[];
  openGaps: number;
  topGapEvidence: { question: string; evidence: number }[];
  usage: UsageSample[];
}): AnswerQualityMetrics {
  const { answers, feedback, usage } = input;
  const n = answers.length;
  const noAnswer = answers.filter((a) => a.noAnswer).length;
  const degraded = answers.filter((a) => a.degraded).length;
  const confidences = answers
    .filter((a) => !a.noAnswer && a.confidence !== null)
    .map((a) => a.confidence!) as number[];
  const hist = { lt03: 0, lt05: 0, lt07: 0, gte07: 0 };
  for (const c of confidences) {
    if (c < 0.3) hist.lt03++;
    else if (c < 0.5) hist.lt05++;
    else if (c < 0.7) hist.lt07++;
    else hist.gte07++;
  }
  const took = answers.map((a) => a.tookMs).filter((t): t is number => t !== null).sort((a, b) => a - b);
  const up = feedback.filter((f) => f.verdict === 'up').length;
  const down = feedback.length - up;
  const downRate = feedback.length > 0 ? down / feedback.length : null;
  const noAnswerRate = n > 0 ? noAnswer / n : null;

  const byTool: Record<string, number> = {};
  const byKey: Record<string, number> = {};
  for (const u of usage) {
    byTool[u.tool] = (byTool[u.tool] ?? 0) + 1;
    byKey[u.keyId] = (byKey[u.keyId] ?? 0) + 1;
  }

  const reasons: string[] = [];
  let verdict: AnswerQualityMetrics['verdict'] = 'OK';
  if (noAnswerRate !== null && noAnswerRate > NO_ANSWER_FAIL) {
    verdict = 'FAIL';
    reasons.push(`odsetek odmów ${(noAnswerRate * 100).toFixed(0)}% > ${NO_ANSWER_FAIL * 100}%`);
  } else if (noAnswerRate !== null && noAnswerRate > NO_ANSWER_WARN) {
    verdict = 'WARN';
    reasons.push(`odsetek odmów ${(noAnswerRate * 100).toFixed(0)}% > ${NO_ANSWER_WARN * 100}%`);
  }
  if (downRate !== null && downRate > DOWN_FAIL) {
    verdict = 'FAIL';
    reasons.push(`odsetek 👎 ${(downRate * 100).toFixed(0)}% > ${DOWN_FAIL * 100}%`);
  } else if (downRate !== null && downRate > DOWN_WARN) {
    if (verdict === 'OK') verdict = 'WARN';
    reasons.push(`odsetek 👎 ${(downRate * 100).toFixed(0)}% > ${DOWN_WARN * 100}%`);
  }

  return {
    answers: n,
    noAnswerRate: noAnswerRate !== null ? +noAnswerRate.toFixed(3) : null,
    degradedRate: n > 0 ? +(degraded / n).toFixed(3) : null,
    avgConfidence:
      confidences.length > 0
        ? +(confidences.reduce((s, c) => s + c, 0) / confidences.length).toFixed(3)
        : null,
    confidenceHistogram: hist,
    p50TookMs: percentile(took, 50),
    p95TookMs: percentile(took, 95),
    feedback: { up, down, downRate: downRate !== null ? +downRate.toFixed(3) : null },
    openGaps: input.openGaps,
    topGapEvidence: input.topGapEvidence.slice(0, 5),
    usage: { calls: usage.length, byTool, byKey },
    verdict,
    verdictReasons: reasons,
  };
}
