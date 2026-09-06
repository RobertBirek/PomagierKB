import { describe, it, expect } from 'vitest';
import { looksLikeStaticAsset } from '../src/statics.js';

/**
 * Fallback SPA zwracał `index.html` z kodem 200 dla KAŻDEJ nieznanej ścieżki — także dla
 * nieistniejącego chunku JS. Literówka w nazwie albo niekompletne wdrożenie dawały białą
 * stronę u użytkownika, a monitoring widział same dwusetki (audyt 2026-09-06, D13-01).
 */
describe('looksLikeStaticAsset — plik statyczny czy trasa SPA', () => {
  it('artefakty builda są plikami, także bez rozszerzenia w nazwie', () => {
    expect(looksLikeStaticAsset('/assets/index-a1b2c3.js')).toBe(true);
    expect(looksLikeStaticAsset('/assets/index-a1b2c3.css')).toBe(true);
    expect(looksLikeStaticAsset('/assets/literowka')).toBe(true);
  });

  it('ścieżka z rozszerzeniem w ostatnim segmencie to plik', () => {
    expect(looksLikeStaticAsset('/favicon.ico')).toBe(true);
    expect(looksLikeStaticAsset('/manifest.webmanifest')).toBe(true);
    expect(looksLikeStaticAsset('/robots.txt')).toBe(true);
  });

  it('trasy SPA nie są plikami', () => {
    expect(looksLikeStaticAsset('/')).toBe(false);
    expect(looksLikeStaticAsset('/inbox')).toBe(false);
    expect(looksLikeStaticAsset('/inbox/')).toBe(false);
    expect(looksLikeStaticAsset('/kb/StagingSmoke')).toBe(false);
    expect(looksLikeStaticAsset('/settings/llm')).toBe(false);
  });

  it('namespace z kropką w nazwie jest wyjątkiem znanym i zaakceptowanym', () => {
    // Rejestr KB dopuszcza kropkę w namespace, więc /kb/Foo.Bar zostałoby uznane za plik
    // i dostało 404 zamiast strony. Nie ma dziś takiej bazy, a alternatywą byłaby lista
    // dozwolonych rozszerzeń — krucha w drugą stronę. Test istnieje, żeby ta decyzja
    // była widoczna, gdyby ktoś kiedyś taką bazę założył.
    expect(looksLikeStaticAsset('/kb/Foo.Bar')).toBe(true);
  });
});
