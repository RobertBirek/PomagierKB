/**
 * Czysta logika strony /mcp v2 (bez Reacta/DOM — testy w test/mcp-page-lib.test.ts):
 * - filtr kliencki i pełny sort listy kluczy API,
 * - walidacja formularza „Nowy klucz" per pole,
 * - liczba aktywnych kluczy konta serwisowego (kaskada disable),
 * - wariant plakietki latencji health.
 * Uzupełnia nietykalne lib/mcp.ts (keyBadgeInfo/daysUntil/validateProfileForm).
 */
import type { SortState } from '../../ui/data-table-core';

// ── filtr + sort kluczy ─────────────────────────────────────────────────────

export interface KeyRowLike {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  profileId: string;
  status: string;
  expiresAt: string;
}

/**
 * Filtr kliencki kluczy: fraza (case-insensitive) w etykiecie, prefiksie,
 * profilu lub nazwie właściciela (resolver ownerName — mapowanie userId→nazwa).
 */
export function filterKeys<T extends KeyRowLike>(
  keys: readonly T[],
  query: string,
  ownerName: (userId: string) => string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...keys];
  return keys.filter(
    (key) =>
      key.label.toLowerCase().includes(q) ||
      key.prefix.toLowerCase().includes(q) ||
      key.profileId.toLowerCase().includes(q) ||
      ownerName(key.userId).toLowerCase().includes(q),
  );
}

function keySortValue(key: KeyRowLike, column: string, ownerName: (userId: string) => string): string {
  switch (column) {
    case 'owner':
      return ownerName(key.userId).toLowerCase();
    case 'profile':
      return key.profileId;
    case 'expires':
      return key.expiresAt;
    case 'status':
      return key.status;
    default:
      return key.label.toLowerCase();
  }
}

/** Pełny sort kliencki kluczy (kopia wejścia; ISO-daty sortują się leksykalnie). */
export function sortKeys<T extends KeyRowLike>(
  keys: readonly T[],
  sort: SortState | undefined,
  ownerName: (userId: string) => string,
): T[] {
  const out = [...keys];
  if (sort === undefined) return out;
  const dir = sort.dir === 'asc' ? 1 : -1;
  out.sort(
    (a, b) =>
      keySortValue(a, sort.key, ownerName).localeCompare(keySortValue(b, sort.key, ownerName), 'pl') *
      dir,
  );
  return out;
}

// ── konta serwisowe: kaskada disable ────────────────────────────────────────

/** Liczba AKTYWNYCH kluczy danego użytkownika (licznik w AlertDialogu disable). */
export function countActiveKeys(
  keys: readonly { userId: string; status: string }[],
  userId: string,
): number {
  return keys.filter((key) => key.userId === userId && key.status === 'active').length;
}

// ── health: latencja jako plakietka ─────────────────────────────────────────

/** Wariant plakietki latencji: <500 ms ok, <2000 ms warn, dalej fail. */
export function latencyVariant(ms: number): 'ok' | 'warn' | 'fail' {
  if (ms < 500) return 'ok';
  if (ms < 2000) return 'warn';
  return 'fail';
}

// ── formularz „Nowy klucz": walidacja per pole ──────────────────────────────

export type KeyIdentity = 'me' | 'service' | 'new';

export interface CreateKeyFormInput {
  label: string;
  profileId: string;
  identity: KeyIdentity;
  /** Id istniejącego konta serwisowego (istotne przy identity='service'). */
  serviceId: string;
  /** Nazwa nowego konta serwisowego (istotna przy identity='new'). */
  newServiceName: string;
  ttlDays: number;
}

export type CreateKeyErrorField = 'label' | 'profile' | 'service' | 'serviceName' | 'ttl';

export interface CreateKeyFormResult {
  ok: boolean;
  errors: CreateKeyErrorField[];
}

/**
 * Walidacja formularza klucza — błędy PRZY POLACH (koniec zbiorczego komunikatu):
 * etykieta niepusta, profil wybrany, tożsamość kompletna, TTL całkowite 1–365.
 */
export function validateCreateKeyForm(input: CreateKeyFormInput): CreateKeyFormResult {
  const errors: CreateKeyErrorField[] = [];
  if (input.label.trim() === '') errors.push('label');
  if (input.profileId === '') errors.push('profile');
  if (input.identity === 'service' && input.serviceId === '') errors.push('service');
  if (input.identity === 'new' && input.newServiceName.trim() === '') errors.push('serviceName');
  if (!Number.isInteger(input.ttlDays) || input.ttlDays < 1 || input.ttlDays > 365) {
    errors.push('ttl');
  }
  return { ok: errors.length === 0, errors };
}
