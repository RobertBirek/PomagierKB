import { pl, type PlKey } from './pl';

export type { PlKey };

/**
 * Tłumaczenie z typowanym kluczem i interpolacją `{name}`.
 * Brak parametru → placeholder zostaje w tekście (łatwe do wychwycenia w QA).
 * Czysta funkcja — testowana w test/t.test.ts.
 */
export function t(key: PlKey, params?: Record<string, string | number>): string {
  const template: string = pl[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Formatowanie daty ISO po polsku (krótko: 12.03.2026, 14:05). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short' }).format(d);
}

/** Formatowanie liczby po polsku (separatory tysięcy). */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat('pl-PL').format(n);
}
