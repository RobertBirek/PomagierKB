import { describe, expect, it } from 'vitest';
import {
  addDocTypeRow,
  addExampleDocType,
  archiveConfirmed,
  canProceed,
  filterKbs,
  groupQualityChecks,
  initialWizardState,
  MAX_DOC_TYPES,
  qualityCheckLabelKey,
  setWizardName,
  setWizardNamespace,
  sortKbs,
  wizardBack,
  wizardNext,
  wizardPayload,
  type KbWizardState,
} from '../src/components/kb/kb-lib';
import { pl } from '../src/i18n/pl';

function kb(namespace: string, name: string, status = 'active', documents = 0, dirty = false) {
  return { namespace, name, status, dirty, totals: { documents, chunks: 0, pendingDrafts: 0 } };
}

const KBS = [
  kb('ProductDocs', 'Katalog produktów', 'active', 12),
  kb('Procedures', 'Procedury', 'draft', 3),
  kb('OldStuff', 'Stara baza', 'archived', 99),
  kb('Broken', 'Zepsuta', 'error', 0, true),
];

describe('filterKbs()', () => {
  it('domyślny filtr „all" UKRYWA zarchiwizowane', () => {
    const out = filterKbs(KBS, '', 'all');
    expect(out.map((x) => x.namespace)).toEqual(['ProductDocs', 'Procedures', 'Broken']);
  });

  it('filtr statusu „archived" pokazuje tylko archiwum', () => {
    expect(filterKbs(KBS, '', 'archived').map((x) => x.namespace)).toEqual(['OldStuff']);
  });

  it('fraza działa na nazwie i namespace, case-insensitive', () => {
    expect(filterKbs(KBS, 'produkt', 'all')).toHaveLength(1);
    expect(filterKbs(KBS, 'procED', 'all').map((x) => x.namespace)).toEqual(['Procedures']);
  });

  it('fraza + status łączą się (AND)', () => {
    expect(filterKbs(KBS, 'stara', 'all')).toHaveLength(0);
    expect(filterKbs(KBS, 'stara', 'archived')).toHaveLength(1);
  });
});

describe('sortKbs()', () => {
  it('bez sortu zwraca kopię w oryginalnej kolejności', () => {
    const out = sortKbs(KBS, undefined);
    expect(out.map((x) => x.namespace)).toEqual(KBS.map((x) => x.namespace));
    expect(out).not.toBe(KBS);
  });

  it('sort po liczbie dokumentów (totals) desc', () => {
    const out = sortKbs(KBS, { key: 'totals', dir: 'desc' });
    expect(out[0]?.namespace).toBe('OldStuff');
    expect(out[3]?.namespace).toBe('Broken');
  });

  it('sort po nazwie asc używa localeCompare pl', () => {
    const out = sortKbs(KBS, { key: 'name', dir: 'asc' });
    expect(out.map((x) => x.name)).toEqual(['Katalog produktów', 'Procedury', 'Stara baza', 'Zepsuta']);
  });
});

describe('archiveConfirmed()', () => {
  it('wymaga dokładnego przepisania namespace (z trim)', () => {
    expect(archiveConfirmed('ProductDocs', 'ProductDocs')).toBe(true);
    expect(archiveConfirmed('  ProductDocs  ', 'ProductDocs')).toBe(true);
  });

  it('odrzuca inną wielkość liter i częściowe dopasowanie', () => {
    expect(archiveConfirmed('productdocs', 'ProductDocs')).toBe(false);
    expect(archiveConfirmed('ProductDoc', 'ProductDocs')).toBe(false);
    expect(archiveConfirmed('', 'ProductDocs')).toBe(false);
  });
});

describe('kreator: przejścia kroków + walidacja', () => {
  it('start: krok 1, jeden pusty wiersz typu, createProject=true', () => {
    const state = initialWizardState();
    expect(state.step).toBe(1);
    expect(state.documentTypes).toEqual([{ name: '', description: '' }]);
    expect(state.createProject).toBe(true);
  });

  it('krok 1 blokuje Dalej bez nazwy albo z niepoprawnym namespace', () => {
    let state = initialWizardState();
    expect(canProceed(state)).toBe(false);
    expect(wizardNext(state).step).toBe(1);

    state = setWizardName(state, 'Katalog produktów');
    expect(state.namespace).toBe('KatalogProduktow'); // auto-sugestia (transliteracja)
    expect(canProceed(state)).toBe(true);
    expect(wizardNext(state).step).toBe(2);

    const badNs = setWizardNamespace(state, 'zle-znaki');
    expect(canProceed(badNs)).toBe(false);
    expect(wizardNext(badNs).step).toBe(1);
  });

  it('ręczna edycja namespace wyłącza auto-sugestię', () => {
    let state = setWizardName(initialWizardState(), 'Alfa');
    state = setWizardNamespace(state, 'MojeWlasne');
    state = setWizardName(state, 'Beta');
    expect(state.namespace).toBe('MojeWlasne');
  });

  it('krok 2 nie blokuje; krok 3 powtarza walidację kroku 1; back cofa', () => {
    let state: KbWizardState = { ...initialWizardState(), name: 'Test', namespace: 'TestKb' };
    state = wizardNext(state); // → 2
    expect(canProceed(state)).toBe(true);
    state = wizardNext(state); // → 3
    expect(state.step).toBe(3);
    expect(wizardNext(state).step).toBe(3); // nie wychodzi poza 3
    expect(wizardBack(state).step).toBe(2);
    expect(wizardBack(wizardBack(state)).step).toBe(1);
    expect(wizardBack(initialWizardState()).step).toBe(1);
  });

  it('payload: trim + odrzucenie typów bez nazwy', () => {
    const state: KbWizardState = {
      ...initialWizardState(),
      name: '  Baza  ',
      namespace: 'Baza',
      description: ' opis ',
      documentTypes: [
        { name: ' procedura ', description: ' opis ' },
        { name: '', description: 'sierota' },
      ],
      createProject: false,
    };
    expect(wizardPayload(state)).toEqual({
      namespace: 'Baza',
      name: 'Baza',
      description: 'opis',
      documentTypes: [{ name: 'procedura', description: 'opis' }],
      createProject: false,
    });
  });
});

describe('kreator: typy dokumentów (wiersze + chipy)', () => {
  it('addDocTypeRow respektuje limit MAX_DOC_TYPES', () => {
    const full = Array.from({ length: MAX_DOC_TYPES }, (_, i) => ({ name: `t${i}`, description: '' }));
    expect(addDocTypeRow(full)).toHaveLength(MAX_DOC_TYPES);
    expect(addDocTypeRow([])).toHaveLength(1);
  });

  it('chip wypełnia pierwszy pusty wiersz zamiast dodawać nowy', () => {
    const out = addExampleDocType([{ name: '', description: '' }], 'FAQ');
    expect(out).toEqual([{ name: 'FAQ', description: '' }]);
  });

  it('chip nie duplikuje istniejącej nazwy (case-insensitive)', () => {
    const list = [{ name: 'faq', description: 'x' }];
    expect(addExampleDocType(list, 'FAQ')).toEqual(list);
  });

  it('chip dopisuje nowy wiersz, gdy nie ma pustego', () => {
    const out = addExampleDocType([{ name: 'procedura', description: '' }], 'regulamin');
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ name: 'regulamin', description: '' });
  });
});

describe('raport quality gate', () => {
  it('grupuje checki: failed(error)/warned(warn)/passed', () => {
    const groups = groupQualityChecks([
      { id: 'a', level: 'error', ok: true, details: '' },
      { id: 'b', level: 'error', ok: false, details: 'zle' },
      { id: 'c', level: 'warn', ok: false, details: 'meh' },
    ]);
    expect(groups.passed.map((c) => c.id)).toEqual(['a']);
    expect(groups.failed.map((c) => c.id)).toEqual(['b']);
    expect(groups.warned.map((c) => c.id)).toEqual(['c']);
  });

  it('uszkodzony check (bez pól) trafia do failed (fail-closed)', () => {
    const groups = groupQualityChecks([{}]);
    expect(groups.failed).toHaveLength(1);
  });

  it('etykiety checków: znane id mają klucz, nieznane → generic (bez wycieku id)', () => {
    expect(qualityCheckLabelKey('row_count_match')).toBe('kb.qualityCheck.row_count_match');
    expect(qualityCheckLabelKey('cos_nowego')).toBe('kb.qualityCheck.generic');
    // każdy zwracany klucz istnieje w słowniku
    expect(pl[qualityCheckLabelKey('live_search_sanity')]).toBeTypeOf('string');
    expect(pl[qualityCheckLabelKey('???')]).toBeTypeOf('string');
  });
});
