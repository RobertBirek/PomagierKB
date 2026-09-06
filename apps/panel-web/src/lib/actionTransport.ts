/**
 * Czysta logika obserwacji długobieżnych akcji (bez React i bez DOM) —
 * testowana w test/actionTransport.test.ts, używana przez hooks/useAction.ts.
 */

export type ActionRunStatus = 'running' | 'success' | 'error' | 'cancelled' | 'unknown';

const TERMINAL: readonly ActionRunStatus[] = ['success', 'error', 'cancelled'];

/** Status z API → typ domknięty (nieznana wartość → 'unknown'). */
export function asRunStatus(raw: unknown): ActionRunStatus {
  return raw === 'running' || raw === 'success' || raw === 'error' || raw === 'cancelled'
    ? raw
    : 'unknown';
}

export function isTerminalActionStatus(status: ActionRunStatus): boolean {
  return TERMINAL.includes(status);
}

export interface SseEndState {
  /** Hook odmontowany albo abort — nie ruszamy już niczego. */
  stopped: boolean;
  /** Ostatni status widziany na strumieniu. */
  status: ActionRunStatus;
}

/**
 * Czy po ZAKOŃCZENIU czytania strumienia SSE przechodzimy na odpytywanie?
 *
 * apiSse rozwiązuje obietnicę normalnie także wtedy, gdy strumień urwał
 * pośrednik (timeout Caddy, restart panel-api, uśpiona karta, zerwane
 * połączenie mobilne) — to NIE jest błąd, więc gałąź .catch() nigdy się nie
 * wykona. Bez tej decyzji hook zostawał na status:'running' i pasek postępu
 * wisiał w nieskończoność, choć akcja dawno się zakończyła (także błędem).
 */
export function shouldFallbackToPolling({ stopped, status }: SseEndState): boolean {
  return !stopped && !isTerminalActionStatus(status);
}
