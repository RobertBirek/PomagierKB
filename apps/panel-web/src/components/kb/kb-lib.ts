/**
 * Czysta logika strony /kb v2 (bez Reacta/DOM — testy w test/kb-lib.test.ts):
 * - filtr kliencki listy baz (szukajka + status; ARCHIWALNE domyślnie ukryte),
 * - pełny sort kliencki (lista niepaginowana),
 * - stan kreatora „Nowa baza" (3 kroki: przejścia + walidacja),
 * - potwierdzenie archiwizacji przez przepisanie namespace.
 * Kontrakt API: apps/panel-api/src/routes/kbs.ts (+ services/kb.ts kbToApi).
 */
import type { SortState } from '../../ui/data-table-core';
import { isValidNamespace, suggestNamespace } from '../../lib/namespace';
import type { PlKey } from '../../i18n/pl';
import type { QualityCheckDto } from './types';

// ── filtr + sort listy ──────────────────────────────────────────────────────

export const KB_STATUS_FILTERS = ['all', 'active', 'draft', 'error', 'archived'] as const;
export type KbStatusFilter = (typeof KB_STATUS_FILTERS)[number];

export interface KbFilterable {
  namespace: string;
  name: string;
  status: string;
}

/**
 * Filtr kliencki listy baz: fraza (name/namespace, case-insensitive) + status.
 * 'all' NIE pokazuje zarchiwizowanych (świadomy wybór z filtra 'archived').
 */
export function filterKbs<T extends KbFilterable>(
  items: readonly T[],
  query: string,
  status: KbStatusFilter,
): T[] {
  const q = query.trim().toLowerCase();
  return items.filter((kb) => {
    if (status === 'all') {
      if (kb.status === 'archived') return false;
    } else if (kb.status !== status) {
      return false;
    }
    if (q === '') return true;
    return kb.name.toLowerCase().includes(q) || kb.namespace.toLowerCase().includes(q);
  });
}

export interface KbSortable extends KbFilterable {
  dirty: boolean;
  totals: { documents: number; chunks: number; pendingDrafts: number };
}

/** Wartość sortowania dla klucza kolumny (nieznany klucz → nazwa). */
function sortValue(kb: KbSortable, key: string): string | number {
  switch (key) {
    case 'status':
      return kb.status;
    case 'totals':
      return kb.totals.documents;
    case 'pending':
      return kb.totals.pendingDrafts;
    case 'dirty':
      return kb.dirty ? 1 : 0;
    default:
      return kb.name.toLowerCase();
  }
}

/** Pełny sort kliencki (kopia; stabilny — Array.prototype.sort jest stabilny). */
export function sortKbs<T extends KbSortable>(items: readonly T[], sort: SortState | undefined): T[] {
  const out = [...items];
  if (sort === undefined) return out;
  const dir = sort.dir === 'asc' ? 1 : -1;
  out.sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'pl') * dir;
  });
  return out;
}

// ── raport quality gate: etykiety i grupowanie checków ──────────────────────

/**
 * Ludzka etykieta checka quality gate (pipeline/quality-gate.ts — 10 checków).
 * Nieznany id NIE wycieka surowo — etykieta ogólna (wzorzec z lib/preflight).
 */
const QUALITY_CHECK_LABEL_KEYS: Record<string, PlKey> = {
  export_files_exist: 'kb.qualityCheck.export_files_exist',
  row_count_match: 'kb.qualityCheck.row_count_match',
  ids_unique_nonempty: 'kb.qualityCheck.ids_unique_nonempty',
  referential_integrity: 'kb.qualityCheck.referential_integrity',
  indexed_field_limits: 'kb.qualityCheck.indexed_field_limits',
  promoted_coverage: 'kb.qualityCheck.promoted_coverage',
  duplicate_source_urls: 'kb.qualityCheck.duplicate_source_urls',
  builds_finished: 'kb.qualityCheck.builds_finished',
  dirty_flag: 'kb.qualityCheck.dirty_flag',
  live_search_sanity: 'kb.qualityCheck.live_search_sanity',
};

export function qualityCheckLabelKey(id: string): PlKey {
  return QUALITY_CHECK_LABEL_KEYS[id] ?? 'kb.qualityCheck.generic';
}

export interface QualityGroups {
  /** Nieprzeszłe checki level=error (przesądzają FAIL). */
  failed: QualityCheckDto[];
  /** Nieprzeszłe checki level=warn. */
  warned: QualityCheckDto[];
  /** Checki zaliczone. */
  passed: QualityCheckDto[];
}

/**
 * Grupowanie checków raportu jakości (kształt {id,level,ok,details} —
 * pipeline/quality-gate.ts). Pola tolerowane defensywnie: brak ok → nieprzeszły,
 * brak level → error (fail-closed przy uszkodzonym checks_json).
 */
export function groupQualityChecks(checks: readonly QualityCheckDto[]): QualityGroups {
  const groups: QualityGroups = { failed: [], warned: [], passed: [] };
  for (const check of checks) {
    if (check.ok === true) groups.passed.push(check);
    else if (check.level === 'warn') groups.warned.push(check);
    else groups.failed.push(check);
  }
  return groups;
}

// ── archiwizacja: potwierdzenie przepisaniem namespace ──────────────────────

/** Przycisk „Archiwizuj" aktywny dopiero, gdy wpisany tekst = namespace (trim, exact). */
export function archiveConfirmed(input: string, namespace: string): boolean {
  return input.trim() === namespace;
}

// ── kreator „Nowa baza" (3 kroki) ───────────────────────────────────────────

export type WizardStep = 1 | 2 | 3;

export interface DocTypeDraft {
  name: string;
  description: string;
}

export interface KbWizardState {
  step: WizardStep;
  name: string;
  namespace: string;
  /** true = użytkownik ręcznie edytował namespace (koniec auto-sugestii). */
  nsTouched: boolean;
  description: string;
  documentTypes: DocTypeDraft[];
  createProject: boolean;
}

export const MAX_DOC_TYPES = 20;

/** Chipy-przykłady typów dokumentów (krok 2). */
export const DOC_TYPE_EXAMPLES = ['procedura', 'FAQ', 'regulamin', 'karta produktu'] as const;

export function initialWizardState(): KbWizardState {
  return {
    step: 1,
    name: '',
    namespace: '',
    nsTouched: false,
    description: '',
    documentTypes: [{ name: '', description: '' }],
    createProject: true,
  };
}

/** Nazwa → auto-sugestia namespace, dopóki użytkownik nie edytował pola ręcznie. */
export function setWizardName(state: KbWizardState, name: string): KbWizardState {
  return {
    ...state,
    name,
    namespace: state.nsTouched ? state.namespace : suggestNamespace(name),
  };
}

export function setWizardNamespace(state: KbWizardState, namespace: string): KbWizardState {
  return { ...state, namespace, nsTouched: true };
}

/**
 * Czy z bieżącego kroku można iść dalej (albo — dla kroku 3 — wysłać):
 * krok 1 wymaga niepustej nazwy i poprawnego namespace; kroki 2/3 nie blokują
 * (typy dokumentów są opcjonalne), ale krok 3 powtarza warunek kroku 1.
 */
export function canProceed(state: KbWizardState): boolean {
  if (state.step === 2) return true;
  return state.name.trim() !== '' && isValidNamespace(state.namespace);
}

export function wizardNext(state: KbWizardState): KbWizardState {
  if (!canProceed(state) || state.step === 3) return state;
  return { ...state, step: (state.step + 1) as WizardStep };
}

export function wizardBack(state: KbWizardState): KbWizardState {
  if (state.step === 1) return state;
  return { ...state, step: (state.step - 1) as WizardStep };
}

/** Dodaj pusty wiersz typu dokumentu (limit MAX_DOC_TYPES → bez zmian). */
export function addDocTypeRow(list: readonly DocTypeDraft[]): DocTypeDraft[] {
  if (list.length >= MAX_DOC_TYPES) return [...list];
  return [...list, { name: '', description: '' }];
}

/**
 * Chip-przykład: wypełnia pierwszy pusty wiersz albo dodaje nowy (limit 20);
 * duplikat nazwy (trim, case-insensitive) → bez zmian.
 */
export function addExampleDocType(list: readonly DocTypeDraft[], example: string): DocTypeDraft[] {
  const wanted = example.trim().toLowerCase();
  if (list.some((docType) => docType.name.trim().toLowerCase() === wanted)) return [...list];
  const emptyIndex = list.findIndex((docType) => docType.name.trim() === '');
  if (emptyIndex >= 0) {
    return list.map((docType, i) => (i === emptyIndex ? { ...docType, name: example } : docType));
  }
  if (list.length >= MAX_DOC_TYPES) return [...list];
  return [...list, { name: example, description: '' }];
}

export interface CreateKbPayload {
  namespace: string;
  name: string;
  description: string;
  documentTypes: { name: string; description: string }[];
  createProject: boolean;
}

/** Body POST /api/v1/kbs — trim pól, odrzucenie typów bez nazwy. */
export function wizardPayload(state: KbWizardState): CreateKbPayload {
  return {
    namespace: state.namespace,
    name: state.name.trim(),
    description: state.description.trim(),
    documentTypes: state.documentTypes
      .map((docType) => ({ name: docType.name.trim(), description: docType.description.trim() }))
      .filter((docType) => docType.name !== ''),
    createProject: state.createProject,
  };
}
