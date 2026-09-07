import { detectPii, summarize, type PiiFinding, type PiiReport, type PiiType } from './detect.js';

/**
 * Polityka postępowania z danymi osobowymi na granicy wyjścia do dostawcy LLM.
 *
 * Dlaczego maskujemy na EGRESSIE, a nie przy zapisie do bazy: granicą ryzyka jest
 * przekazanie danych **poza EOG**, a nie ich przechowywanie. Nasz dysk jest wewnątrz
 * perymetru RODO, dostawca nie jest. Maskowanie przy ingeście trwale zniszczyłoby treść
 * (nazwisko w procedurze kadrowej bywa istotne dla odpowiedzi), a i tak nie chroniłoby
 * niczego więcej — z bazy do modelu treść i tak by potem poszła.
 *
 * `flag` jest domyślne CELOWO. Zanim zaczniemy niszczyć treść, chcemy wiedzieć, czy w ogóle
 * jest co niszczyć: detekcja bez modyfikacji daje liczby, na których można oprzeć decyzję,
 * a nie psuje ani jednej odpowiedzi. Włączenie `mask` na bazie, w której PII nie ma,
 * to sam koszt bez korzyści.
 */
export type PiiPolicy = 'off' | 'flag' | 'mask';

export const PII_POLICIES: readonly PiiPolicy[] = ['off', 'flag', 'mask'];
export const PII_POLICY_DEFAULT: PiiPolicy = 'flag';

/** Nieznana wartość z bazy → domyślna polityka; nigdy `off` (fail-closed w stronę ochrony). */
export function coercePiiPolicy(value: unknown): PiiPolicy {
  return typeof value === 'string' && (PII_POLICIES as readonly string[]).includes(value)
    ? (value as PiiPolicy)
    : PII_POLICY_DEFAULT;
}

const PLACEHOLDER: Record<PiiType, string> = {
  pesel: '[PESEL]',
  nip: '[NIP]',
  regon: '[REGON]',
  iban: '[NUMER-RACHUNKU]',
  id_card: '[NR-DOWODU]',
  email: '[E-MAIL]',
  phone: '[TELEFON]',
  birth_date: '[DATA-URODZENIA]',
};

export interface PiiResult {
  /** Tekst po zastosowaniu polityki — dla `off`/`flag` identyczny z wejściem. */
  text: string;
  /** Podsumowanie wolne od wartości; `null` gdy polityka to `off` (nie skanowaliśmy). */
  report: PiiReport | null;
  /** Czy tekst został faktycznie zmieniony (przydatne do logu i UI). */
  masked: boolean;
}

/** Podmienia trafienia na placeholdery, idąc OD KOŃCA, żeby offsety pozostały ważne. */
export function maskFindings(text: string, findings: readonly PiiFinding[]): string {
  let out = text;
  for (let i = findings.length - 1; i >= 0; i -= 1) {
    const finding = findings[i]!;
    out = out.slice(0, finding.start) + PLACEHOLDER[finding.type] + out.slice(finding.end);
  }
  return out;
}

/**
 * Stosuje politykę do treści. Wywoływane na KAŻDYM wyjściu treści dokumentu do LLM
 * (`wrapUntrusted` z podaną polityką) — nie przy zapisie i nie w retrievalu.
 */
export function applyPiiPolicy(text: string, policy: PiiPolicy): PiiResult {
  if (policy === 'off') return { text, report: null, masked: false };
  const findings = detectPii(text);
  const report = summarize(findings);
  if (policy === 'flag' || findings.length === 0) return { text, report, masked: false };
  return { text: maskFindings(text, findings), report, masked: true };
}
