/**
 * Prefill formularza /add z search-params (?question= — z luki wiedzy albo
 * z odpowiedzi „nie znalazłem" na /ask). Czyste funkcje — testy w
 * test/prefill.test.ts.
 */

/** Maksymalna długość pytania przenoszonego w URL (deep-link musi być krótki). */
export const PREFILL_QUESTION_MAX = 500;

export interface AddPrefill {
  question: string;
}

/**
 * Walidacja search-params trasy /add: {question?} — trim + limit długości;
 * pusta/nie-string → brak prefillu (undefined). Używana w validateSearch
 * routera ORAZ do budowy nagłówka „Uzupełniasz lukę: …" na stronie.
 */
export function parseAddSearch(search: Record<string, unknown>): Partial<AddPrefill> {
  const raw = search['question'];
  if (typeof raw !== 'string') return {};
  const question = raw.trim().slice(0, PREFILL_QUESTION_MAX);
  if (question === '') return {};
  return { question };
}

/**
 * Search-params deep-linku /ask → /add (CTA „uzupełnij brak"). Zwraca null,
 * gdy pytanie po przycięciu jest puste — wtedy link prowadzi na goły /add.
 */
export function buildAddLinkSearch(question: string): AddPrefill | null {
  const trimmed = question.trim().slice(0, PREFILL_QUESTION_MAX);
  if (trimmed === '') return null;
  return { question: trimmed };
}
