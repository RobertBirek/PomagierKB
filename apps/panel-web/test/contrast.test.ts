/**
 * Test regresyjny kontrastu tokenów design systemu v2 (D13-02).
 * Czyta REALNY plik src/styles/app.css (obie palety) i sprawdza progi WCAG:
 * 4.5:1 dla tokenów używanych jako tekst (panel używa 11-15 px, więc ulga 3:1
 * dla „dużego tekstu" NIE ma tu zastosowania) i 3:1 dla granic kontrolek
 * oraz wskaźnika fokusu (WCAG 1.4.11).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compositeTint, contrastRatio } from '../src/lib/contrast';

const CSS = readFileSync(fileURLToPath(new URL('../src/styles/app.css', import.meta.url)), 'utf8');

/** Wycina blok { ... } zaczynający się od podanego nagłówka. */
function block(header: string): string {
  const start = CSS.indexOf(header);
  if (start < 0) throw new Error(`brak bloku ${header} w app.css`);
  const open = CSS.indexOf('{', start);
  const end = CSS.indexOf('\n}', open);
  return CSS.slice(open, end);
}

const LIGHT_BLOCK = block('@theme {');
const DARK_BLOCK = block("[data-theme='dark'] {");

/** Wartość tokenu --color-<name> z bloku (ostatnia deklaracja wygrywa). */
function token(css: string, name: string): string {
  const re = new RegExp(`--color-${name}:\\s*([^;]+);`, 'g');
  let last: string | null = null;
  for (const m of css.matchAll(re)) last = (m[1] as string).trim();
  if (last === null) throw new Error(`brak tokenu --color-${name}`);
  return last;
}

/** Rozkłada color-mix(in srgb, #hex N%, transparent) na [hex, udział 0..1]. */
function tintRecipe(value: string): { color: string; pct: number } {
  const m = /color-mix\(in srgb,\s*(#[0-9a-f]{6})\s+(\d+)%,\s*transparent\)/i.exec(value);
  if (m === null) throw new Error(`nieoczekiwany kształt tintu: ${value}`);
  return { color: m[1] as string, pct: Number(m[2]) / 100 };
}

interface Palette {
  name: string;
  css: string;
}

const PALETTES: Palette[] = [
  { name: 'light', css: LIGHT_BLOCK },
  { name: 'dark', css: DARK_BLOCK },
];

/** Tła, na których realnie leży treść (surface-3 = hover/active wypełnienie). */
const FLAT = ['bg', 'surface', 'surface-2', 'surface-3'] as const;
/** Kontenery, w których mogą stać plakietki z tintem i kontrolki. */
const CONTAINERS = ['bg', 'surface', 'surface-2'] as const;
/** Tokeny używane jako kolor TEKSTU (Badge tone=tint, Alert, linki, plakietki). */
const TEXT_TOKENS = ['text', 'text-secondary', 'text-tertiary'] as const;
const STATUS_TOKENS = ['ok', 'warn', 'fail', 'info', 'accent'] as const;

describe.each(PALETTES)('paleta $name — kontrast WCAG AA', ({ css }) => {
  const bgOf = (name: string): string => token(css, name);

  it.each(TEXT_TOKENS)('%s ma ≥4.5:1 na każdym tle treści', (name) => {
    const fg = token(css, name);
    for (const bg of FLAT) {
      expect(contrastRatio(fg, bgOf(bg)), `${name} / ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(STATUS_TOKENS)('%s jako tekst ma ≥4.5:1 na tłach i na własnym tincie', (name) => {
    const fg = token(css, name);
    for (const bg of FLAT) {
      expect(contrastRatio(fg, bgOf(bg)), `${name} / ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    const tint = tintRecipe(token(css, `${name}-tint`));
    expect(tint.color, `--color-${name}-tint musi mieszać ten sam odcień co --color-${name}`).toBe(
      fg,
    );
    for (const bg of CONTAINERS) {
      const composed = compositeTint(tint.color, tint.pct, bgOf(bg));
      expect(contrastRatio(fg, composed), `${name} / ${name}-tint na ${bg}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('on-accent ma ≥4.5:1 na wypełnieniu akcentem (przycisk primary, wszystkie stany)', () => {
    const onAccent = token(css, 'on-accent');
    for (const state of ['accent', 'accent-hover', 'accent-active']) {
      expect(contrastRatio(onAccent, token(css, state)), `on-accent / ${state}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('on-fail ma ≥4.5:1 na wypełnieniu fail (przycisk danger)', () => {
    expect(contrastRatio(token(css, 'on-fail'), token(css, 'fail'))).toBeGreaterThanOrEqual(4.5);
  });

  it('border-strong (granica kontrolki) ma ≥3:1 — WCAG 1.4.11', () => {
    const border = token(css, 'border-strong');
    for (const bg of CONTAINERS) {
      expect(contrastRatio(border, bgOf(bg)), `border-strong / ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('accent jako pierścień fokusu ma ≥3:1 — WCAG 1.4.11', () => {
    const accent = token(css, 'accent');
    for (const bg of CONTAINERS) {
      expect(contrastRatio(accent, bgOf(bg)), `accent / ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('contrastRatio()', () => {
  it('skrajne wartości: czarny/biały = 21, ten sam kolor = 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#4c5acd', '#4c5acd')).toBeCloseTo(1, 5);
  });

  it('compositeTint() 0% = tło, 100% = kolor', () => {
    expect(compositeTint('#107435', 0, '#ffffff')).toBe('#ffffff');
    expect(compositeTint('#107435', 1, '#ffffff')).toBe('#107435');
  });
});
