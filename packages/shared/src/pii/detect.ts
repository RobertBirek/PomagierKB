/**
 * Detekcja danych osobowych w treści dokumentów — czysta logika, zero I/O i frameworka.
 *
 * Po co: treść dokumentów wychodzi z tego systemu do dostawcy LLM **poza EOG**
 * (`docs/data-governance.md` §1.3). Dziś w bazach są karty produktów i dokumenty operacyjne,
 * ale kontrola musi istnieć ZANIM ktoś wgra CV albo akta pracownicze — po fakcie nie da się
 * cofnąć wysyłki. Ten moduł wykrywa; co z tym zrobić, decyduje polityka bazy wiedzy (`policy.ts`).
 *
 * NAJWAŻNIEJSZA ZASADA PROJEKTOWA: fałszywe trafienie kosztuje tu więcej niż przeoczenie.
 * Detektor, który krzyczy na każdy kod produktu, zostanie po tygodniu wyłączony i wtedy nie
 * ochroni przed niczym. Dlatego:
 *  - każdy identyfikator z sumą kontrolną jest sprawdzany SUMĄ, nie samą długością —
 *    `12345678901` to nie PESEL, tylko jedenaście cyfr;
 *  - numer telefonu i data urodzenia są wykrywane WYŁĄCZNIE w kontekście (prefiks `+48`,
 *    słowo `tel.`, `ur.`), bo nasze bazy są pełne dziewięciocyfrowych kodów katalogowych
 *    i dat obowiązywania procedur.
 *
 * Wartości znalezione NIGDY nie trafiają do raportu (`PiiReport` niesie wyłącznie liczniki
 * i typy) — inaczej sam mechanizm ochrony wyciekałby dane do logów i audytu.
 */

export type PiiType =
  | 'pesel'
  | 'nip'
  | 'regon'
  | 'iban'
  | 'id_card'
  | 'email'
  | 'phone'
  | 'birth_date';

export interface PiiFinding {
  type: PiiType;
  /** Offset początku w tekście wejściowym (włącznie). */
  start: number;
  /** Offset końca (wyłącznie). */
  end: number;
}

/** Podsumowanie wolne od wartości — bezpieczne do logów, audytu i metadanych draftu. */
export interface PiiReport {
  total: number;
  counts: Partial<Record<PiiType, number>>;
  types: PiiType[];
}

// ── Sumy kontrolne ──────────────────────────────────────────────────────────────────────

function digits(value: string): number[] {
  return [...value].filter((c) => c >= '0' && c <= '9').map((c) => c.charCodeAt(0) - 48);
}

/** PESEL: 11 cyfr, wagi 1-3-7-9…, cyfra kontrolna + sensowna data w pierwszych sześciu. */
export function isValidPesel(value: string): boolean {
  const d = digits(value);
  if (d.length !== 11) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i += 1) sum += d[i]! * weights[i]!;
  if ((10 - (sum % 10)) % 10 !== d[10]) return false;
  // Miesiąc niesie stulecie (+0/+20/+40/+60/+80). Bez tej kontroli losowe 11 cyfr
  // przechodzą samą sumą z prawdopodobieństwem 1/10 — za często jak na dokumenty techniczne.
  const month = d[2]! * 10 + d[3]!;
  const century = Math.floor(month / 20);
  const realMonth = month - century * 20;
  if (century > 4 || realMonth < 1 || realMonth > 12) return false;
  const day = d[4]! * 10 + d[5]!;
  return day >= 1 && day <= 31;
}

/** NIP: 10 cyfr, wagi 6-5-7-2-3-4-5-6-7 mod 11 (reszta 10 = numer nieprawidłowy). */
export function isValidNip(value: string): boolean {
  const d = digits(value);
  if (d.length !== 10) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += d[i]! * weights[i]!;
  const control = sum % 11;
  return control !== 10 && control === d[9];
}

/** REGON: 9 lub 14 cyfr, osobne zestawy wag; reszta 10 traktowana jako 0. */
export function isValidRegon(value: string): boolean {
  const d = digits(value);
  const weights9 = [8, 9, 2, 3, 4, 5, 6, 7];
  const weights14 = [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8];
  const check = (ds: number[], weights: number[]): boolean => {
    let sum = 0;
    for (let i = 0; i < weights.length; i += 1) sum += ds[i]! * weights[i]!;
    return sum % 11 % 10 === ds[weights.length];
  };
  if (d.length === 9) return check(d, weights9);
  if (d.length === 14) return check(d, weights9.concat()) && check(d, weights14);
  return false;
}

/** IBAN: przeniesienie czterech pierwszych znaków na koniec, litery→liczby, mod 97 === 1. */
export function isValidIban(value: string): boolean {
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of code) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Dowód osobisty: 3 litery + cyfra kontrolna + 5 cyfr, wagi 7-3-1-0-7-3-1-7-3. */
export function isValidIdCard(value: string): boolean {
  const compact = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{3}\d{6}$/.test(compact)) return false;
  const weights = [7, 3, 1, 0, 7, 3, 1, 7, 3];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    const char = compact[i]!;
    const value_ = char >= 'A' ? char.charCodeAt(0) - 55 : char.charCodeAt(0) - 48;
    sum += value_ * weights[i]!;
  }
  return sum % 10 === Number(compact[3]);
}

// ── Detektory ───────────────────────────────────────────────────────────────────────────

interface Detector {
  type: PiiType;
  pattern: RegExp;
  /** Grupa przechwytująca z właściwą wartością (domyślnie całe dopasowanie). */
  group?: number;
  validate?: (value: string) => boolean;
}

/**
 * Kontekst wymagany przy telefonie i dacie urodzenia. Bez niego `123456789` (kod katalogowy)
 * i `2026-08-01` (data obowiązywania procedury) zalałyby raport szumem.
 */
const PHONE_CONTEXT = String.raw`(?:\+48\s*|tel\.?\s*:?\s*|telefon\s*:?\s*|kom\.?\s*:?\s*|nr\s+tel\.?\s*:?\s*)`;
const BIRTH_CONTEXT = String.raw`(?:ur\.\s*|urodz\w*\s*(?:si[eę]\s*)?(?:dnia\s*)?|data\s+urodzenia\s*:?\s*)`;
// REGON i dowód też wymagają kontekstu, i to z rachunku prawdopodobieństwa, nie z ostrożności:
// losowy ciąg 9 cyfr przechodzi sumę REGON-u z prawdopodobieństwem ~1/11, a `ABC123456`
// wygląda jak numer dowodu równie dobrze jak jak kod katalogowy oprawy. Bez kotwicy oba
// detektory zalałyby raport szumem z kart produktowych — a raport, któremu nikt nie wierzy,
// nie chroni przed niczym. PESEL kotwicy nie potrzebuje, bo poza sumą kontrolną musi jeszcze
// nieść sensowną datę urodzenia (~2% trafień losowych zamiast ~9%).
const REGON_CONTEXT = String.raw`(?:regon\s*:?\s*)`;
const ID_CARD_CONTEXT = String.raw`(?:dow[oó]d\s+(?:osobisty\s*)?(?:nr\s*)?:?\s*|seria\s+i\s+numer\s*:?\s*|nr\s+dowodu\s*:?\s*)`;

const DETECTORS: Detector[] = [
  // Kolejność ma znaczenie: IBAN przed NIP/REGON, bo numer rachunku zawiera w sobie ciągi
  // cyfr, które samą sumą mogłyby udać krótszy identyfikator (rozstrzyganie w dedupOverlaps).
  {
    type: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{2,4}){2,8}\b/g,
    validate: isValidIban,
  },
  {
    type: 'pesel',
    pattern: /(?<![\d-])\d{11}(?![\d-])/g,
    validate: isValidPesel,
  },
  {
    type: 'nip',
    pattern: /(?<![\d-])(?:\d{10}|\d{3}-\d{3}-\d{2}-\d{2}|\d{3}-\d{2}-\d{2}-\d{3})(?![\d-])/g,
    validate: isValidNip,
  },
  {
    type: 'regon',
    pattern: new RegExp(REGON_CONTEXT + String.raw`(\d{14}|\d{9})\b`, 'gi'),
    group: 1,
    validate: isValidRegon,
  },
  {
    type: 'id_card',
    pattern: new RegExp(ID_CARD_CONTEXT + String.raw`([A-Z]{3}\s?\d{6})\b`, 'gi'),
    group: 1,
    validate: isValidIdCard,
  },
  {
    type: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  },
  {
    type: 'phone',
    pattern: new RegExp(PHONE_CONTEXT + String.raw`(\d{3}[ -]?\d{3}[ -]?\d{3}|\d{9})\b`, 'gi'),
    group: 1,
  },
  {
    type: 'birth_date',
    pattern: new RegExp(
      BIRTH_CONTEXT + String.raw`(\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4})`,
      'gi',
    ),
    group: 1,
  },
];

/**
 * Usuwa nakładające się trafienia — wygrywa DŁUŻSZE (bardziej szczegółowe). Bez tego
 * dziewięć cyfr wewnątrz numeru rachunku byłoby raportowane drugi raz jako REGON, a licznik
 * przestałby cokolwiek znaczyć.
 */
function dedupOverlaps(findings: PiiFinding[]): PiiFinding[] {
  const sorted = [...findings].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: PiiFinding[] = [];
  for (const finding of sorted) {
    if (out.some((kept) => finding.start < kept.end && kept.start < finding.end)) continue;
    out.push(finding);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Wszystkie trafienia w tekście, posortowane po pozycji, bez nakładek. */
export function detectPii(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  for (const detector of DETECTORS) {
    // Świeży RegExp na każde wywołanie: literały z /g trzymają lastIndex między wywołaniami
    // i przy współdzieleniu gubiłyby co drugie dopasowanie.
    const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const groupIndex = detector.group ?? 0;
      const value = match[groupIndex];
      if (value === undefined) continue;
      if (detector.validate !== undefined && !detector.validate(value)) continue;
      const start = groupIndex === 0 ? match.index : match.index + match[0].indexOf(value);
      findings.push({ type: detector.type, start, end: start + value.length });
    }
  }
  return dedupOverlaps(findings);
}

/** Podsumowanie wolne od wartości — to jedyny kształt, który wolno logować i zapisywać. */
export function summarize(findings: readonly PiiFinding[]): PiiReport {
  const counts: Partial<Record<PiiType, number>> = {};
  for (const finding of findings) counts[finding.type] = (counts[finding.type] ?? 0) + 1;
  return {
    total: findings.length,
    counts,
    types: Object.keys(counts).sort() as PiiType[],
  };
}
