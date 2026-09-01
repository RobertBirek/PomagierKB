/**
 * Mapowanie confidence (0..1 z AnswerResult — packages/shared/src/answer) na
 * plakietkę pewności odpowiedzi (soczewka product: „uczciwe nie-wiem" +
 * „plakietka niepewności"). Czysta funkcja — testy w test/confidence.test.ts.
 * Progi: ≥0.7 wysoka; ≥0.45 średnia (spójnie z LEARNING_THRESHOLD_DEFAULT
 * backendu — poniżej tej wartości backend loguje lukę wiedzy); < 0.45 niska.
 */
import type { PlKey } from '../i18n/pl';
import type { BadgeVariant } from './status';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export const CONFIDENCE_HIGH_THRESHOLD = 0.7;
export const CONFIDENCE_MEDIUM_THRESHOLD = 0.45;

/** Poziom pewności; brak/nie-liczba/NaN → defensywnie 'low' (fail-closed). */
export function confidenceLevel(confidence: number | null | undefined): ConfidenceLevel {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return 'low';
  if (confidence >= CONFIDENCE_HIGH_THRESHOLD) return 'high';
  if (confidence >= CONFIDENCE_MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

export interface ConfidenceBadge {
  level: ConfidenceLevel;
  variant: BadgeVariant;
  labelKey: PlKey;
}

const BADGE_BY_LEVEL: Record<ConfidenceLevel, ConfidenceBadge> = {
  high: { level: 'high', variant: 'ok', labelKey: 'ask.confidence.high' },
  medium: { level: 'medium', variant: 'warn', labelKey: 'ask.confidence.medium' },
  low: { level: 'low', variant: 'fail', labelKey: 'ask.confidence.low' },
};

/** Plakietka (wariant koloru + klucz PL) dla surowego confidence. */
export function confidenceBadge(confidence: number | null | undefined): ConfidenceBadge {
  return BADGE_BY_LEVEL[confidenceLevel(confidence)];
}
