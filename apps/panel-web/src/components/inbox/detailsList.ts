/**
 * Formatowanie metadanych szkicu na details-list (dl klucz→wartość) — CZYSTA
 * logika bez React/DOM. Surowy JSON zostaje tylko w zwijanych „Danych
 * technicznych"; tu wartości są spłaszczane do czytelnych stringów.
 * Testy: test/inbox-detailsList.test.ts.
 */
import { t } from '../../i18n/t';

export interface MetadataEntry {
  key: string;
  value: string;
  /** ISO-data → strona renderuje przez formatDateTime. */
  isDate: boolean;
}

/** ISO 8601 z czasem (metadane backendu: createdAt/updatedAt itp.). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Pojedyncza wartość → czytelny string ('—' dla pustych/nieskończonych). */
export function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? t('inbox.meta.yes') : t('inbox.meta.no');
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (typeof value === 'string') return value === '' ? '—' : value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    if (value.every(isPrimitive)) return value.map((v) => formatMetadataValue(v)).join(', ');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Obiekt metadanych → wpisy details-list w kolejności kluczy z API. */
export function metadataEntries(metadata: Record<string, unknown>): MetadataEntry[] {
  return Object.entries(metadata).map(([key, value]) => ({
    key,
    value: formatMetadataValue(value),
    isDate: typeof value === 'string' && ISO_DATE_RE.test(value),
  }));
}
