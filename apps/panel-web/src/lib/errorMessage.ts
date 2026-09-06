/**
 * Jedyne miejsce, w którym błąd zamienia się w tekst dla użytkownika.
 * Wcześniej ta sama funkcja była skopiowana kilkanaście razy po komponentach
 * (errorMessage/errMsg) i KAŻDA gubiła requestId z koperty błędu — użytkownik
 * nie miał czym zacytować wpisu w logu serwera (D13-04).
 *
 * Czysta funkcja bez DOM — testy w test/errorMessage.test.ts.
 */
import { ApiError } from './api';
import { t } from '../i18n/t';

/** requestId błędu, jeśli serwer go podał (koperta {ok:false,error.requestId}). */
export function errorRequestId(err: unknown): string | null {
  return err instanceof ApiError ? err.requestId : null;
}

/**
 * Komunikat błędu + dyskretny identyfikator zgłoszenia, gdy serwer go podał.
 * Nieznany kształt błędu → generyczny komunikat ze słownika (żadnych stacków
 * ani surowych obiektów w UI).
 */
export function errorMessage(err: unknown): string {
  const message = err instanceof ApiError ? err.message : t('common.error');
  const requestId = errorRequestId(err);
  return requestId === null ? message : t('error.withRequestId', { message, id: requestId });
}
