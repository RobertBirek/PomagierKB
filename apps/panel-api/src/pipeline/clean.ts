import { wrapUntrusted, type LlmClient } from '@pomagierkb/shared/llm';
import { looksHumanText } from './extract.js';
import { CLEAN_PROFILES, type CleanProfileName } from './cleanProfiles.js';

/**
 * Etap 3 pipeline'u — CZYSZCZENIE TEKSTU (pipeline-frontend.md §c, Etap 3).
 * cleanContent to CZYSTA funkcja regexowa (profile w cleanProfiles.ts).
 * Opcjonalny przebieg LLM (model openie z settings, tekst ≤12k, wrapUntrusted)
 * z guardem bezpieczeństwa: wynik ≥60% długości wejścia + looksHumanText,
 * inaczej fallback na wynik regexowy.
 */

export interface CleanResult {
  text: string;
  profile: CleanProfileName;
  /** 1 - out/in (0..1) — ile treści wycięto względem wejścia. */
  removedRatio: number;
  /** true tylko gdy wynik LLM przeszedł guard i został użyty. */
  aiUsed: boolean;
}

/** Maksymalna długość tekstu wysyłanego do LLM (spójna z wrapUntrusted). */
export const AI_CLEAN_MAX_CHARS = 12_000;
/** Guard: wynik LLM musi zachować ≥60% długości wejścia. */
export const AI_CLEAN_MIN_KEEP_RATIO = 0.6;

function removedRatioOf(input: string, output: string): number {
  if (input.length === 0) return 0;
  return Math.max(0, Math.min(1, 1 - output.length / input.length));
}

/**
 * Czyszczenie regexowe — czysta funkcja:
 * 1) drop całych linii boilerplate (dropLinePatterns),
 * 2) wycinanie fraz inline (inlinePatterns),
 * 3) normalizacja paginacji i whitespace (spacje końcowe, ≥3 puste linie → 1).
 */
export function cleanContent(
  text: string,
  profileName: CleanProfileName = 'generic',
): { text: string; profile: CleanProfileName; removedRatio: number } {
  const profile = CLEAN_PROFILES[profileName];
  const lines = text.split('\n');
  const kept: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed !== '' && profile.dropLinePatterns.some((re) => re.test(trimmed))) continue;

    let out = line;
    for (const re of profile.inlinePatterns) {
      out = out.replace(re, '');
    }
    // Linia, z której inline wyciął wszystko → traktuj jak pustą (nie zostawiaj śmieci).
    kept.push(out.replace(/\s+$/, ''));
  }

  const cleaned = kept
    .join('\n')
    // Normalizacja paginacji rozjechanej między liniami: "Strona\n3\nz\n10" nie
    // występuje po dropLine, ale twarde podziały słów z myślnikiem z OCR sklejamy.
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: cleaned, profile: profileName, removedRatio: removedRatioOf(text, cleaned) };
}

export interface CleanAiDeps {
  /** Klient LLM openie (tańszy) z settings; null/undefined = przebieg wyłączony. */
  llm?: LlmClient | null;
  /** Limit długości tekstu dla przebiegu LLM (default 12 000). */
  maxAiChars?: number;
}

const AI_SYSTEM_PROMPT =
  'Czyścisz tekst dokumentu z boilerplate (menu, stopki, reklamy, elementy nawigacji). ' +
  'Usuń wyłącznie śmieci, ZACHOWAJ całą treść merytoryczną i strukturę nagłówków. ' +
  'Zwróć wyłącznie czysty markdown, bez komentarzy od siebie.';

/**
 * Pełne czyszczenie: regex + opcjonalny przebieg LLM z guardem.
 * Guard: wynik LLM ≥60% długości wejścia i looksHumanText — inaczej (oraz przy
 * każdym błędzie LLM) pozostaje wynik regexowy (aiUsed:false).
 */
export async function cleanWithOptionalAi(
  text: string,
  profileName: CleanProfileName,
  deps: CleanAiDeps = {},
): Promise<CleanResult> {
  const regexResult = cleanContent(text, profileName);
  const base: CleanResult = { ...regexResult, aiUsed: false };

  const llm = deps.llm ?? null;
  const maxChars = deps.maxAiChars ?? AI_CLEAN_MAX_CHARS;
  if (llm === null || regexResult.text.length === 0 || regexResult.text.length > maxChars) {
    return base;
  }

  try {
    const res = await llm.chat({
      system: AI_SYSTEM_PROMPT,
      user: wrapUntrusted(regexResult.text, 'dokument do wyczyszczenia', maxChars),
    });
    const aiText = res.text.trim();
    const keepsEnough = aiText.length >= AI_CLEAN_MIN_KEEP_RATIO * regexResult.text.length;
    if (keepsEnough && looksHumanText(aiText)) {
      return {
        text: aiText,
        profile: profileName,
        removedRatio: removedRatioOf(text, aiText),
        aiUsed: true,
      };
    }
    return base; // guard nie przeszedł — bezpieczny fallback regexowy
  } catch {
    return base; // błąd LLM nigdy nie psuje pipeline'u czyszczenia
  }
}
