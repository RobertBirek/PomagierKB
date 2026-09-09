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
 * CO ZAMIAST: sygnał semantyczny, czyli surowy cosinus.
 *
 * REKALIBRACJA 2026-09-07 (korpus urósł z 2 do 50 chunków). Pierwsza kalibracja szła
 * na 6 pomiarach przy niemal pustej bazie i jej „czysta separacja" była artefaktem —
 * pomiar na 50 pytaniach (28 on-topic / 12 near-miss / 10 off-topic) pokazuje co innego:
 *   on-topic  min 0.702  p10 0.733  p50 0.803  max 0.874
 *   near-miss min 0.666  p50 0.724  p90 0.743  max 0.762
 *   off-topic min 0.617  p50 0.657  max 0.711
 *
 * WYNIK: próg 0.70 ZOSTAJE — leży dokładnie na dolnej krawędzi rozkładu on-topic
 * (minimum 0.702), więc nie odrzuca ANI JEDNEGO trafnego pytania, a jednocześnie
 * odsiewa 9/10 pytań spoza dziedziny. To była pierwotna funkcja bramki i ją pełni.
 *
 * Macierz błędów (fałszywe odmowy / fałszywe odpowiedzi na 22 negatywach):
 *   0.68 → 0/28 (0%)  | 12/22 (55%)
 *   0.70 → 0/28 (0%)  | 11/22 (50%)   ← WYBRANE: zero odmów przy najniższym możliwym
 *   0.72 → 2/28 (7%)  |  7/22 (32%)
 *   0.74 → 4/28 (14%) |  2/22 ( 9%)
 * Obniżanie nic nie kupuje (odmów i tak zero), a podnoszenie kosztuje realne pytania
 * operatorskie („co oznacza flaga dirty" 0.702, „jak odrzucić szkic" 0.703).
 *
 * CZEGO TEN PRÓG NIE ZAŁATWIA — i żaden skalar nie załatwi: pasmo near-miss (0.666–0.762)
 * pokrywa się z on-topic (0.702–0.874) niemal w całości. Pytania o replikację PostgreSQL
 * czy migrację z MongoDB są semantycznie blisko, bo korpus mówi o MySQL, Postgresie i S3
 * w kontekście backupu — a odpowiedzi nie ma. Obroną jest warstwa niżej: wymóg cytowań
 * i ścieżka noAnswer, nie ten skalar.
 *
 * PUŁAPKA POMIARU (kosztowała jedną błędną rekomendację): bramka dostaje
 * `retrieval.topVectorScore` — MAKSIMUM z kanału wektorowego. To NIE jest
 * `results[0].vectorScore`, czyli wynik wektorowy tego, co wygrało fuzję RRF; te dwie
 * wielkości potrafią różnić się o 0.1. Mierząc próg, czytaj to samo pole co produkcja.
 *
 * POMIAR 2026-09-09 (korpus 14 650 chunków po imporcie SubiektKB; 94 on-topic / 37 off-topic,
 * tools/eval/gate-calibration.mjs): on-topic p10 0.709 p50 0.818; off-topic p50 0.652 p90 0.733
 * max 0.844. Macierz: 0.70 → 8/94 odmów (same 1-2-wyrazowe hasła StagingSmoke) | 7/37 fałszywych
 * odpowiedzi; 0.74 → 17/94 | 3/37. Próg 0.70 ZOSTAJE — duży korpus podnosi maksimum kosinusa pytań
 * spoza bazy (semantycznie „blisko" jest teraz prawie wszystko), a wyższy próg płaci realnymi
 * pytaniami. Szczegóły: tools/eval/baseline.json → remeasured.
 *
 * Po każdym istotnym wzroście korpusu POWTÓRZYĆ pomiar — patrz tools/eval/baseline.json.
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
