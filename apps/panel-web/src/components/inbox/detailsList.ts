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

/** Nazwy typów PII po polsku — surowe klucze („pesel", „id_card") nic nie mówią recenzentowi. */
const PII_TYPE_LABEL: Record<string, string> = {
  pesel: 'PESEL',
  nip: 'NIP',
  regon: 'REGON',
  iban: 'numer rachunku',
  id_card: 'numer dowodu',
  email: 'adres e-mail',
  phone: 'numer telefonu',
  birth_date: 'data urodzenia',
};

export interface PiiWarning {
  total: number;
  /** Nazwy typów po polsku, w kolejności z backendu. */
  types: string[];
  /** Polityka bazy w chwili ingestu: off | flag | mask. */
  policy: string;
}

/**
 * Sygnał o danych osobowych w szkicu (metadata.pii — pisane przez intake-worker).
 * Recenzja człowieka jest w tym systemie jedyną bramką przed promocją do grafu, więc
 * informacja „ten dokument zawiera PESEL" musi być WIDOCZNA, a nie schowana w zwijanym
 * JSON-ie z danymi technicznymi. Zwraca null, gdy nic nie wykryto albo kształt jest inny,
 * niż zakładamy (starszy backend) — brak sygnału nigdy nie może wywrócić panelu recenzenta.
 */
export function piiWarning(metadata: Record<string, unknown>): PiiWarning | null {
  const raw = metadata['pii'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const total = typeof obj['total'] === 'number' && Number.isFinite(obj['total']) ? obj['total'] : 0;
  if (total <= 0) return null;
  const types = Array.isArray(obj['types'])
    ? (obj['types'] as unknown[])
        .filter((v): v is string => typeof v === 'string')
        .map((v) => PII_TYPE_LABEL[v] ?? v)
    : [];
  const policy = typeof obj['policy'] === 'string' ? obj['policy'] : 'flag';
  return { total, types, policy };
}
