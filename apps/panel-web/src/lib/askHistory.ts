/**
 * Normalizacja pozycji historii pytań (GET /api/v1/ask/history). Trasa /ask
 * powstaje równolegle (Faza 4) — mapper przyjmuje defensywnie zarówno pola
 * camelCase (kontrakt API), jak i snake_case (kształt wierszy answers z
 * packages/shared/src/db/repos/answersFeedback.ts), a śmieci odrzuca.
 * Czyste funkcje — testy w test/askHistory.test.ts.
 */

export interface AskHistoryItem {
  id: string;
  question: string;
  confidence: number | null;
  noAnswer: boolean;
  createdAt: string;
  /** Ostatni werdykt feedbacku użytkownika (jeśli był). */
  verdict: 'up' | 'down' | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pick(o: Record<string, unknown>, camel: string, snake: string): unknown {
  return o[camel] !== undefined ? o[camel] : o[snake];
}

/** Jedna pozycja historii albo null (brak wymaganych pól id/question). */
export function normalizeHistoryItem(raw: unknown): AskHistoryItem | null {
  const o = asRecord(raw);
  if (o === null) return null;
  const id = o['id'];
  const question = o['question'];
  if (typeof id !== 'string' || id === '' || typeof question !== 'string' || question === '') {
    return null;
  }
  const confidenceRaw = pick(o, 'confidence', 'confidence');
  const confidence =
    typeof confidenceRaw === 'number' && !Number.isNaN(confidenceRaw) ? confidenceRaw : null;
  const noAnswerRaw = pick(o, 'noAnswer', 'no_answer');
  const noAnswer = noAnswerRaw === true || noAnswerRaw === 1;
  const createdAtRaw = pick(o, 'createdAt', 'created_at');
  const createdAt = typeof createdAtRaw === 'string' ? createdAtRaw : '';

  // Werdykt: pole 'verdict' wprost albo ostatni wpis tablicy 'feedback'.
  let verdict: AskHistoryItem['verdict'] = null;
  const direct = o['verdict'];
  if (direct === 'up' || direct === 'down') {
    verdict = direct;
  } else {
    const feedback = o['feedback'];
    if (Array.isArray(feedback) && feedback.length > 0) {
      const last = asRecord(feedback[feedback.length - 1]);
      const v = last?.['verdict'];
      if (v === 'up' || v === 'down') verdict = v;
    }
  }
  return { id, question, confidence, noAnswer, createdAt, verdict };
}

/** Lista historii z odpowiedzi API: {items:[…]} albo goła tablica; inne → []. */
export function normalizeHistory(data: unknown): AskHistoryItem[] {
  const list = Array.isArray(data) ? data : (asRecord(data)?.['items'] ?? null);
  if (!Array.isArray(list)) return [];
  const out: AskHistoryItem[] = [];
  for (const raw of list) {
    const item = normalizeHistoryItem(raw);
    if (item !== null) out.push(item);
  }
  return out;
}
