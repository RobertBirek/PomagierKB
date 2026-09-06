/**
 * Bramka odmowy — czysta logika (audyt D8-01).
 *
 * DLACZEGO NIE topNorm: poprzednia bramka liczyła `topScore / (activeChannels × 1/61)`
 * i porównywała z 0.2. Top fuzji RRF jest z definicji rank-1 w co najmniej jednym
 * kanale, więc topScore ≥ 1/61, a stąd topNorm ≥ 1/activeChannels ≥ 1/3 > 0.2 dla
 * każdego NIEPUSTEGO wyniku. Bramka odrzucała więc wyłącznie pustkę: empirycznie
 * 0/14 pytań spoza bazy odrzuconych (topNorm 0.5–1.0, „przepis na bigos" = 0.99).
 * RRF mierzy ZGODNOŚĆ rankingów kanałów, nie trafność — normalizacja tego nie zmienia.
 *
 * CO ZAMIAST: sygnał semantyczny, czyli surowy cosinus. Rozkład zmierzony na żywej
 * bazie (evidence/D8-vector-raw-scores.json):
 *   on-topic  0.871 / 0.789 / 0.778   (min 0.778)
 *   off-topic 0.635 / 0.609 / 0.515   (max 0.635)
 * Separacja jest czysta; próg 0.70 leży prawie dokładnie pośrodku (margines +0.078
 * nad maksimum off-topic i −0.078 pod minimum on-topic).
 *
 * Gdy sygnału semantycznego nie ma (tryb zdegradowany: sam FTS5, brak embeddingów),
 * bramka wymaga LEKSYKALNEGO trafienia AND — luźny fallback OR po rdzeniach potrafi
 * trafić pytanie spoza bazy przez podciąg ('świa' ⊂ 'światła') i nie jest dowodem.
 */

export type GateReason = 'no_results' | 'low_relevance' | 'lexical_fallback_only';

export interface RelevanceGateInput {
  /** Liczba wyników retrievalu (0 → odmowa bez dalszych rozważań). */
  resultCount: number;
  /**
   * Najlepszy dostępny cosinus trafności (kanał wektorowy OpenSPG i/lub rerank
   * embed); null = żaden kanał semantyczny nie zadziałał.
   */
  semanticScore: number | null;
  /** Kanał FTS trafił wyrażeniem AND (wszystkie rdzenie), a nie luźnym OR. */
  lexicalStrict: boolean;
  /** Próg cosinusa (ustawienie 'answer.minScore', patrz resolveMinRelevance). */
  minRelevance: number;
}

export interface GateDecision {
  pass: boolean;
  reason: GateReason | null;
  /** Sygnał, na którym zapadła decyzja — do metadanych luki wiedzy i diagnostyki. */
  signal: 'semantic' | 'lexical' | 'empty';
}

/** Domyślny próg trafności — kalibracja na żywym rozkładzie cosinusów (patrz nagłówek). */
export const ANSWER_MIN_RELEVANCE_DEFAULT = 0.7;
/**
 * Wartości poniżej tego progu pochodzą sprzed tej zmiany (surowy RRF ~0.01 albo
 * martwa normalizacja kanałów z domyślnym 0.2) i pod nową semantyką znaczyłyby
 * „bramka wyłączona". Fail-closed: traktujemy je jak brak ustawienia.
 */
export const MIN_RELEVANCE_LEGACY_CUTOFF = 0.5;
const MIN_RELEVANCE_MAX = 0.99;

/** Próg z ustawienia → sensowny zakres 0.5..0.99 (poza nim: default). */
export function resolveMinRelevance(raw: number | null | undefined): number {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return ANSWER_MIN_RELEVANCE_DEFAULT;
  if (raw < MIN_RELEVANCE_LEGACY_CUTOFF) return ANSWER_MIN_RELEVANCE_DEFAULT;
  return Math.min(raw, MIN_RELEVANCE_MAX);
}

/** Najlepszy z dostępnych sygnałów semantycznych (null gdy żadnego nie ma). */
export function bestSemanticScore(...scores: (number | null | undefined)[]): number | null {
  const usable = scores.filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
  return usable.length > 0 ? Math.max(...usable) : null;
}

export function evaluateRelevanceGate(input: RelevanceGateInput): GateDecision {
  if (input.resultCount <= 0) return { pass: false, reason: 'no_results', signal: 'empty' };
  if (input.semanticScore !== null) {
    return input.semanticScore >= input.minRelevance
      ? { pass: true, reason: null, signal: 'semantic' }
      : { pass: false, reason: 'low_relevance', signal: 'semantic' };
  }
  return input.lexicalStrict
    ? { pass: true, reason: null, signal: 'lexical' }
    : { pass: false, reason: 'lexical_fallback_only', signal: 'lexical' };
}
