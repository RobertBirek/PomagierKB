/**
 * Współczynniki kontrastu WCAG 2.x — czysta arytmetyka kolorów, bez DOM.
 * Używane przez test regresyjny tokenów design systemu (test/contrast.test.ts),
 * żeby paleta nie cofnęła się poniżej AA przy kolejnej iteracji designu.
 *
 * Progi: 4.5:1 dla tekstu (AA, rozmiary 11-15 px w tym panelu), 3:1 dla granic
 * kontrolek i wskaźnika fokusu (WCAG 1.4.11 Non-text Contrast).
 */

export type Rgb = readonly [number, number, number];

/** '#rrggbb' → [r,g,b] (0-255). Rzuca dla wartości spoza formatu. */
export function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) throw new Error(`nieobsługiwany kolor: ${hex}`);
  const v = m[1] as string;
  return [
    Number.parseInt(v.slice(0, 2), 16),
    Number.parseInt(v.slice(2, 4), 16),
    Number.parseInt(v.slice(4, 6), 16),
  ];
}

function channelLuminance(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Relatywna luminancja wg WCAG 2.x (sRGB). */
export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelLuminance(rgb[0]) +
    0.7152 * channelLuminance(rgb[1]) +
    0.0722 * channelLuminance(rgb[2])
  );
}

/** Współczynnik kontrastu dwóch kolorów (1..21). Kolejność argumentów nieistotna. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseHex(a)) + 0.05;
  const lb = relativeLuminance(parseHex(b)) + 0.05;
  return la > lb ? la / lb : lb / la;
}

function toHex(rgb: readonly number[]): string {
  return (
    '#' +
    rgb
      .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * Kompozycja półprzezroczystego tintu na tle: color-mix(in srgb, C p%, transparent)
 * narysowany na `backdrop` daje ten sam wynik co alpha-blend C z alfą p.
 */
export function compositeTint(color: string, pct: number, backdrop: string): string {
  const fg = parseHex(color);
  const bg = parseHex(backdrop);
  return toHex(fg.map((c, i) => c * pct + (bg[i] as number) * (1 - pct)));
}
