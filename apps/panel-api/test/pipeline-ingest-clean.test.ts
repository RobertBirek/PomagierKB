import { describe, it, expect } from 'vitest';
import type { LlmClient } from '@pomagierkb/shared/llm';
import { cleanContent, cleanWithOptionalAi } from '../src/pipeline/clean.js';
import { pickProfile, CLEAN_PROFILES } from '../src/pipeline/cleanProfiles.js';

/**
 * Etap 3 — czyszczenie: cleanContent (czysta funkcja) usuwa boilerplate PL
 * a ZACHOWUJE treść merytoryczną; przebieg LLM tylko z guardem (≥60% długości
 * + looksHumanText), każdy błąd/regres LLM → fallback regexowy.
 */

const DIRTY = [
  'Menu',
  'Strona główna',
  '# Dobór opraw do magazynu wysokiego składowania',
  '',
  'REKLAMA',
  'Przy regałach wysokich stosuje się oprawy liniowe LED o rozsyle głębokim.',
  'Udostępnij na Facebooku:',
  'Natężenie oświetlenia w strefie kompletacji powinno wynosić minimum 300 luksów.',
  '',
  '3',
  'Strona 3 z 12',
  '© 2024 Portal Oświetleniowy',
  'Polityka prywatności',
  'Zapisz się do newslettera już dziś!',
].join('\n');

function mockLlm(text: string | Error): LlmClient {
  return {
    chat: async () => {
      if (text instanceof Error) throw text;
      return { text };
    },
    embed: async () => [],
  };
}

describe('cleanContent (regex, czysta funkcja)', () => {
  it('usuwa boilerplate PL, zachowuje treść merytoryczną i nagłówki', () => {
    const res = cleanContent(DIRTY, 'generic');
    expect(res.text).toContain('# Dobór opraw do magazynu');
    expect(res.text).toContain('oprawy liniowe LED');
    expect(res.text).toContain('minimum 300 luksów');
    expect(res.text).not.toContain('REKLAMA');
    expect(res.text).not.toContain('Strona 3 z 12');
    expect(res.text).not.toContain('©');
    expect(res.text).not.toContain('Menu');
    expect(res.text).not.toContain('newslettera');
    expect(res.text).not.toMatch(/^\d+$/m); // goły numer strony
    expect(res.removedRatio).toBeGreaterThan(0);
    expect(res.removedRatio).toBeLessThan(1);
    expect(res.profile).toBe('generic');
  });

  it('profil news dodatkowo tnie stopki portali; docs tnie "Spis treści"', () => {
    expect(cleanContent('Źródło: PAP\nTreść wiadomości o oświetleniu ulicznym.', 'news').text).toBe(
      'Treść wiadomości o oświetleniu ulicznym.',
    );
    expect(cleanContent('Spis treści\nRozdział o fotometrii.', 'docs').text).toBe(
      'Rozdział o fotometrii.',
    );
  });

  it('normalizuje whitespace i skleja słowa łamane myślnikiem (OCR)', () => {
    const res = cleanContent('oświet-\nlenie   hali\n\n\n\n\nkoniec', 'pdf');
    expect(res.text).toContain('oświetlenie hali');
    expect(res.text).not.toMatch(/\n{3,}/);
  });

  it('pickProfile: pdf po mime, blog/docs/news po URL, generic dla tekstu', () => {
    expect(pickProfile({ mime: 'application/pdf' })).toBe('pdf');
    expect(pickProfile({ sourceUrl: 'https://x.pl/blog/wpis' })).toBe('blog');
    expect(pickProfile({ sourceUrl: 'https://docs.x.pl/a' })).toBe('docs');
    expect(pickProfile({ sourceUrl: 'https://portal.pl/artykul' })).toBe('news');
    expect(pickProfile({})).toBe('generic');
    for (const name of Object.keys(CLEAN_PROFILES)) {
      expect(CLEAN_PROFILES[name as keyof typeof CLEAN_PROFILES].name).toBe(name);
    }
  });
});

describe('cleanWithOptionalAi (guard bezpieczeństwa)', () => {
  const input = DIRTY;

  it('bez klienta LLM → wynik regexowy, aiUsed:false', async () => {
    const res = await cleanWithOptionalAi(input, 'generic', {});
    expect(res.aiUsed).toBe(false);
    expect(res.text).toContain('oprawy liniowe LED');
  });

  it('LLM zwraca pełnoprawny tekst → aiUsed:true', async () => {
    const aiText =
      '# Dobór opraw do magazynu wysokiego składowania\n\n' +
      'Przy regałach wysokich stosuje się oprawy liniowe LED o rozsyle głębokim. ' +
      'Natężenie oświetlenia w strefie kompletacji powinno wynosić minimum 300 luksów.';
    const res = await cleanWithOptionalAi(input, 'generic', { llm: mockLlm(aiText) });
    expect(res.aiUsed).toBe(true);
    expect(res.text).toBe(aiText);
  });

  it('LLM ucina treść poniżej 60% → guard odrzuca, fallback regexowy', async () => {
    const res = await cleanWithOptionalAi(input, 'generic', { llm: mockLlm('Za krótko.') });
    expect(res.aiUsed).toBe(false);
    expect(res.text).toContain('minimum 300 luksów');
  });

  it('błąd LLM nigdy nie psuje czyszczenia → fallback regexowy', async () => {
    const res = await cleanWithOptionalAi(input, 'generic', { llm: mockLlm(new Error('boom')) });
    expect(res.aiUsed).toBe(false);
    expect(res.text).toContain('minimum 300 luksów');
  });

  it('tekst dłuższy niż limit AI → przebieg LLM pominięty', async () => {
    const llm: LlmClient = {
      chat: async () => {
        throw new Error('nie wolno wołać LLM powyżej limitu');
      },
      embed: async () => [],
    };
    const long = 'Merytoryczna linia o oświetleniu.\n'.repeat(600); // >12k znaków
    const res = await cleanWithOptionalAi(long, 'generic', { llm, maxAiChars: 12_000 });
    expect(res.aiUsed).toBe(false);
  });
});
