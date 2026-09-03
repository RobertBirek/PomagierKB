/**
 * Czysta logika przeglądarki audytu (bez Reacta/DOM — testy w
 * test/audit-core.test.ts, importy RELATYWNE — root vitest bez aliasu '@').
 * - diff before/after wpisu audytu jako lista wierszy {key, before, after, changed},
 * - polski nagłówek dnia („wtorek, 2 września 2026") dla separatorów w tabeli.
 */

export interface DiffRow {
  key: string;
  /** Sformatowana wartość sprzed zmiany ('—' gdy pola nie było). */
  before: string;
  /** Sformatowana wartość po zmianie ('—' gdy pole zniknęło). */
  after: string;
  changed: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Głębokie porównanie JSON-owych wartości (obiekty/tablice/prymitywy). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** Wartość diffa do wyświetlenia: brak pola → '—'; reszta → JSON (zagnieżdżenia inline). */
export function formatDiffValue(value: unknown): string {
  if (value === undefined) return '—';
  const json = JSON.stringify(value);
  // JSON.stringify(undefined-w-obiekcie) nie wystąpi; funkcje/symbole → '—' defensywnie.
  return json === undefined ? '—' : json;
}

/**
 * Diff before/after wpisu audytu → wiersze details-list.
 * - oba null → null (nic do pokazania);
 * - którakolwiek strona nie-null i nie-obiekt (string/liczba/tablica) → null
 *   (strona pokazuje fallback CodeBlock);
 * - null po jednej stronie traktowany jak {} (wpis tworzący/usuwający zasób);
 * - klucze: najpierw kolejność before, potem nowe z after; changed przez
 *   głębokie porównanie (zagnieżdżone obiekty serializowane do JSON w kolumnach).
 */
export function diffObjects(before: unknown, after: unknown): DiffRow[] | null {
  if (before === null && after === null) return null;
  if (before !== null && !isPlainObject(before)) return null;
  if (after !== null && !isPlainObject(after)) return null;
  const beforeObj: Record<string, unknown> = before ?? {};
  const afterObj: Record<string, unknown> = after ?? {};

  const keys = [...Object.keys(beforeObj)];
  for (const key of Object.keys(afterObj)) {
    if (!keys.includes(key)) keys.push(key);
  }

  return keys.map((key) => {
    const hasBefore = Object.hasOwn(beforeObj, key);
    const hasAfter = Object.hasOwn(afterObj, key);
    const changed =
      hasBefore !== hasAfter || !deepEqual(beforeObj[key], afterObj[key]);
    return {
      key,
      before: hasBefore ? formatDiffValue(beforeObj[key]) : '—',
      after: hasAfter ? formatDiffValue(afterObj[key]) : '—',
      changed,
    };
  });
}

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Nagłówek dnia dla separatorów audytu: 'YYYY-MM-DD' →
 * „wtorek, 2 września 2026" (Intl pl-PL, data lokalna — bez przesunięć stref).
 * Wejście spoza formatu (klucz grupy z surowego `at`) wraca bez zmian.
 */
export function formatDayHeading(day: string): string {
  const match = ISO_DAY_RE.exec(day);
  if (match === null) return day;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat('pl-PL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}
