/**
 * Chipy aktywnych filtrów zakładki Szkice (/inbox) — CZYSTA logika bez React/DOM.
 * Filtr aktywny = odbiega od domyślnego widoku (status 'pending', brak KB, brak frazy).
 * Etykiety statusów/baz wstrzykiwane przez resolvery (strona zna słowniki).
 * Testy: test/inbox-filterChips.test.ts.
 */
import { t } from '../../i18n/t';

/** Domyślny filtr statusu zakładki Szkice (chip nie pojawia się dla niego). */
export const DRAFT_STATUS_DEFAULT = 'pending';

export type DraftFilterKey = 'status' | 'kb' | 'q' | 'tag';

export interface DraftFilterState {
  status?: string | undefined;
  kb?: string | undefined;
  q?: string | undefined;
  tag?: string | undefined;
}

export interface FilterChip {
  key: DraftFilterKey;
  label: string;
}

/**
 * Buduje chipy z aktywnych filtrów (kolejność: status, kb, q).
 * `statusLabel` — etykieta PL statusu (w tym 'all'); `kbLabel` — nazwa bazy
 * po namespace (undefined → surowy namespace jako fallback).
 */
export function buildDraftFilterChips(
  filters: DraftFilterState,
  statusLabel: (status: string) => string,
  kbLabel: (ns: string) => string | undefined,
): FilterChip[] {
  const chips: FilterChip[] = [];
  const status = filters.status ?? DRAFT_STATUS_DEFAULT;
  if (status !== DRAFT_STATUS_DEFAULT) {
    chips.push({ key: 'status', label: t('inbox.chip.status', { label: statusLabel(status) }) });
  }
  if (filters.kb !== undefined && filters.kb !== '') {
    chips.push({ key: 'kb', label: t('inbox.chip.kb', { label: kbLabel(filters.kb) ?? filters.kb }) });
  }
  if (filters.q !== undefined && filters.q !== '') {
    chips.push({ key: 'q', label: t('inbox.chip.q', { q: filters.q }) });
  }
  if (filters.tag !== undefined && filters.tag !== '') {
    chips.push({
      key: 'tag',
      label: filters.tag === 'lesson' ? t('inbox.chip.lessons') : t('inbox.chip.tag', { tag: filters.tag }),
    });
  }
  return chips;
}
