/**
 * Walidacja powodu odrzucenia szkicu — CZYSTA logika (macierz potwierdzeń:
 * Reject wymaga powodu). Limity: min 3 znaki (decyzja UX), max 2000
 * (schemat POST /drafts/:id/reject — apps/panel-api/src/routes/drafts.ts).
 * Testy: test/inbox-rejectReason.test.ts.
 */

export const REJECT_REASON_MIN = 3;
export const REJECT_REASON_MAX = 2000;

export type RejectReasonVerdict =
  | { ok: true; reason: string }
  | { ok: false; code: 'tooShort' | 'tooLong' };

/** Trim + zakres długości; pusty/za krótki powód NIE przechodzi (wymagany). */
export function validateRejectReason(raw: string): RejectReasonVerdict {
  const reason = raw.trim();
  if (reason.length < REJECT_REASON_MIN) return { ok: false, code: 'tooShort' };
  if (reason.length > REJECT_REASON_MAX) return { ok: false, code: 'tooLong' };
  return { ok: true, reason };
}
