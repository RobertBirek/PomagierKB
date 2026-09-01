/**
 * Czysta logika strony /settings (bez Reacta/DOM — testy w test/settingsView.test.ts):
 * - maska sekretu (podgląd klucza przed zapisem — lustro maskValue z shared/db),
 * - defensywny odczyt liczby z ustawienia (number wprost albo {value}),
 * - grupowanie wpisów audytu po dniu (nagłówki dzienne w przeglądarce audytu).
 */

/**
 * Maska sekretu do podglądu: 'ab***yz' (2+2 znaki), krótkie (<8) → '***',
 * puste → ''. Lustro maskValue z packages/shared/src/db/repos/settings.ts —
 * podgląd wpisanego klucza przed zapisem wygląda tak samo jak preview z API.
 */
export function maskSecret(value: string): string {
  if (value === '') return '';
  if (value.length < 8) return '***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/**
 * Defensywny odczyt liczby z wartości ustawienia (GET /settings zwraca value
 * jawnych kluczy jako unknown): liczba wprost albo obiekt {value: liczba};
 * wszystko inne → fallback. Lustro readNumberSetting z shared/answer.
 */
export function coerceNumberSetting(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && value !== null) {
    const v = (value as Record<string, unknown>)['value'];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}

export interface DayGroup<T> {
  /** Dzień 'YYYY-MM-DD' (z ISO-8601 pola at); nieparsowalne at → surowa wartość. */
  day: string;
  items: T[];
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Grupowanie wpisów (np. audytu) po dniu z pola `at` (ISO-8601).
 * Zachowuje kolejność wejścia — wpisy przychodzą posortowane malejąco po seq,
 * więc grupy wychodzą od najnowszego dnia. Wpis z at spoza ISO trafia do
 * grupy o kluczu równym surowej wartości (nic nie znika).
 */
export function groupByDay<T extends { at: string }>(items: readonly T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  const byDay = new Map<string, DayGroup<T>>();
  for (const item of items) {
    const day = ISO_DAY_RE.test(item.at) ? item.at.slice(0, 10) : item.at;
    let group = byDay.get(day);
    if (group === undefined) {
      group = { day, items: [] };
      byDay.set(day, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
