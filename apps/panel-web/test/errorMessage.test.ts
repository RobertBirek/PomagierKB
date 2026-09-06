/**
 * D13-04: requestId z koperty błędu musi dotrzeć do UI — bez niego zgłoszenie
 * użytkownika nie da się skorelować z wpisem w logu panel-api.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { errorMessage, errorRequestId } from '../src/lib/errorMessage';
import { pl } from '../src/i18n/pl';

describe('ApiError', () => {
  it('przenosi requestId z koperty', () => {
    const err = new ApiError('conflict', 'Szkic jest już rozstrzygnięty', 409, null, 'req-42');
    expect(err.requestId).toBe('req-42');
  });

  it('brak / pusty requestId → null (nie pokazujemy pustej etykiety)', () => {
    expect(new ApiError('x', 'y', 500).requestId).toBeNull();
    expect(new ApiError('x', 'y', 500, undefined, '').requestId).toBeNull();
    expect(new ApiError('x', 'y', 500, undefined, null).requestId).toBeNull();
  });
});

describe('errorMessage()', () => {
  it('dokleja identyfikator zgłoszenia, gdy serwer go podał', () => {
    const err = new ApiError('internal', 'Nie udało się zapisać szkicu', 500, null, 'req-7');
    expect(errorMessage(err)).toBe('Nie udało się zapisać szkicu (identyfikator zgłoszenia: req-7)');
  });

  it('bez requestId zwraca sam komunikat serwera', () => {
    expect(errorMessage(new ApiError('forbidden', 'Brak uprawnień', 403))).toBe('Brak uprawnień');
  });

  it('nieznany kształt błędu → generyczny komunikat ze słownika (bez stacka w UI)', () => {
    expect(errorMessage(new Error('ReferenceError: x is not defined'))).toBe(pl['common.error']);
    expect(errorMessage('cokolwiek')).toBe(pl['common.error']);
    expect(errorMessage(null)).toBe(pl['common.error']);
  });

  it('errorRequestId() zwraca id tylko dla ApiError', () => {
    expect(errorRequestId(new ApiError('x', 'y', 500, null, 'req-1'))).toBe('req-1');
    expect(errorRequestId(new Error('boom'))).toBeNull();
    expect(errorRequestId(undefined)).toBeNull();
  });
});
