import { describe, it, expect } from 'vitest';
// @ts-expect-error — narzędzie deweloperskie w czystym JS (tools/ nie jest w tsconfigu)
import { checkDrift } from '../../../tools/docs/check-drift.mjs';

/**
 * Bramka przeciw rozjazdowi dokumentacji z kodem (audyt 2026-09-06: D12-01, D12-02).
 *
 * Tabela tras w `docs/design/backend-mcp.md §2.2` opisywała 17 tras, których nie ma,
 * i pomijała 17 istniejących; katalog narzędzi MCP §7.4 opisywał 4 z 11. Obie tabele
 * odtworzono ręcznie — ten test pilnuje, żeby nie zdryfowały ponownie.
 *
 * Test porównuje wyłącznie ZBIORY (metoda+ścieżka, nazwa narzędzia), a nie treść komórek:
 * tabele są ręcznie grupowane tematycznie i opisane, więc generator by tę pracę zniszczył.
 * Gdy dodajesz trasę albo narzędzie, dopisz wiersz do tabeli w tym samym commicie.
 */
describe('dokumentacja nie rozjeżdża się z kodem', () => {
  const result = checkDrift();

  it('tabela tras §2.2 zawiera każdą trasę zadeklarowaną w routes/*.ts', () => {
    expect(result.routes.missingInDoc).toEqual([]);
  });

  it('tabela tras §2.2 nie opisuje tras, których nie ma w kodzie', () => {
    expect(result.routes.missingInCode).toEqual([]);
  });

  it('katalog narzędzi §7.4 zawiera każde narzędzie z rejestru MCP', () => {
    expect(result.tools.missingInDoc).toEqual([]);
  });

  it('katalog narzędzi §7.4 nie opisuje narzędzi, których nie ma w kodzie', () => {
    expect(result.tools.missingInCode).toEqual([]);
  });

  it('liczby w nagłówkach sekcji mają pokrycie w kodzie', () => {
    // sanity: gdyby ekstraktor przestał cokolwiek znajdować, powyższe testy przeszłyby
    // fałszywie (pusty zbiór == pusty zbiór)
    expect(result.routes.codeCount).toBeGreaterThan(50);
    expect(result.tools.codeCount).toBe(11);
  });
});
