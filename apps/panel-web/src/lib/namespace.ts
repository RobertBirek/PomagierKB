/**
 * Walidacja i auto-sugestia namespace bazy wiedzy — CZYSTE funkcje bez DOM.
 * Kontrakt z panel-api (routes/kbs.ts): NAMESPACE_PATTERN = ^[A-Z][A-Za-z0-9]{2,29}$
 * (angielski, PascalCase — wymóg OpenSPG: schema/namespace wyłącznie po angielsku).
 * Testy: test/namespace.test.ts.
 */

export const NAMESPACE_REGEX = /^[A-Z][A-Za-z0-9]{2,29}$/;

export function isValidNamespace(value: string): boolean {
  return NAMESPACE_REGEX.test(value);
}

/** Kod problemu do słownika PL ('kb.nsError.*'); null = poprawny. */
export type NamespaceProblem = 'empty' | 'tooShort' | 'tooLong' | 'badStart' | 'badChars';

export function namespaceProblem(value: string): NamespaceProblem | null {
  if (value === '') return 'empty';
  if (!/^[A-Za-z0-9]+$/.test(value)) return 'badChars';
  if (!/^[A-Z]/.test(value)) return 'badStart';
  if (value.length < 3) return 'tooShort';
  if (value.length > 30) return 'tooLong';
  return null;
}

/** Transliteracja polskich znaków (namespace OpenSPG musi być po angielsku). */
const PL_MAP: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z',
};

function stripDiacritics(text: string): string {
  return text
    .replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (ch) => PL_MAP[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Auto-sugestia namespace z polskiej nazwy bazy: transliteracja → PascalCase
 * po słowach → tylko [A-Za-z0-9] → start wielką literą (prefiks 'Kb' gdy
 * zaczyna się cyfrą) → dopełnienie do min. 3 znaków ('Kb') → obcięcie do 30.
 * Zwraca '' gdy z nazwy nie da się nic zbudować (UI zostawia pole puste).
 */
export function suggestNamespace(name: string): string {
  const words = stripDiacritics(name)
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '');
  if (words.length === 0) return '';
  let out = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '');
  if (out === '') return '';
  if (/^[0-9]/.test(out)) out = 'Kb' + out;
  if (out.length < 3) out = (out + 'Kb').slice(0, 3);
  out = out.slice(0, 30);
  // Po obcięciu/prefiksie wynik musi spełniać wzorzec — inaczej nie sugerujemy.
  return isValidNamespace(out) ? out : '';
}
