import { describe, expect, it } from 'vitest';
import {
  REJECT_REASON_MAX,
  REJECT_REASON_MIN,
  validateRejectReason,
} from '../src/components/inbox/rejectReason';

describe('validateRejectReason()', () => {
  it('pusty / sam whitespace → tooShort (powód WYMAGANY)', () => {
    expect(validateRejectReason('')).toEqual({ ok: false, code: 'tooShort' });
    expect(validateRejectReason('   \n\t ')).toEqual({ ok: false, code: 'tooShort' });
  });

  it('krócej niż minimum po trim → tooShort', () => {
    expect(validateRejectReason('ab')).toEqual({ ok: false, code: 'tooShort' });
    expect(validateRejectReason('  ab  ')).toEqual({ ok: false, code: 'tooShort' });
  });

  it('dokładnie minimum przechodzi (z trimem)', () => {
    expect(REJECT_REASON_MIN).toBe(3);
    expect(validateRejectReason('  abc  ')).toEqual({ ok: true, reason: 'abc' });
  });

  it('typowy powód przechodzi i jest przycięty', () => {
    expect(validateRejectReason(' nieaktualna cena ')).toEqual({
      ok: true,
      reason: 'nieaktualna cena',
    });
  });

  it('powyżej limitu backendu (2000) → tooLong', () => {
    expect(validateRejectReason('x'.repeat(REJECT_REASON_MAX + 1))).toEqual({
      ok: false,
      code: 'tooLong',
    });
    expect(validateRejectReason('x'.repeat(REJECT_REASON_MAX)).ok).toBe(true);
  });
});
