import { describe, expect, it } from 'vitest';
import { checkReadOnly } from '../src/mcp-readonly.mjs';
import {
  AGGREGATES, DOC_TYPES, KINDS, PURCHASE_DOC_TYPES, SALES_DOC_TYPES, SHAPES, applyKAnonymity, plainRows, suppressSmallCounts,
} from '../src/queries-aggregates.mjs';
import {
  GATE_FALSE_POSITIVES, LEGAL_FORM_RULE, NAMES_QUERY_MASKED_IDENTIFIERS, SANCTIONED_NAME_COLUMNS, SUPPLIER_QUERIES, buildSupplierList,
  checkReadOnlyExcept, isLegalEntityName, matchLegalForm,
} from '../src/queries-suppliers.mjs';

const AGG_FN = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i;
/** Kolumny-etykiety dopuszczone mimo słowa „nazwa" (to nie są dane osób). */
const ALLOWED_LABELS = /\b(twp_Nazwa(Ceny)?\d+|khp_Nazwa\d+|grt_Nazwa|mag_Nazwa)\b/g;
const PII_WORDS = /nazwa|adres|nip|pesel|mail|telefon/i;
const HOST_WORDS = /192\.168|INSERTGT|DESKTOP-|\\\\/i;

/** Tekst zapytania na głębokości 0 nawiasów (zawartość nawiasów → „()"). */
function depthZero(sql) {
  let depth = 0;
  let out = '';
  for (const ch of sql.replace(/--[^\n]*/g, ' ')) {
    if (ch === '(') { if (depth === 0) out += '('; depth += 1; continue; }
    if (ch === ')') { depth -= 1; if (depth === 0) out += ')'; continue; }
    if (depth === 0) out += ch;
  }
  return out;
}

/** Pozycje zewnętrznej listy SELECT (między zewnętrznym SELECT a zewnętrznym FROM), rozdzielone przecinkami na głębokości 0. */
function outerSelectItems(sql) {
  const src = sql.replace(/--[^\n]*/g, ' ');
  const upper = src.toUpperCase();
  const isWord = (i) => /[A-Z0-9_]/.test(upper[i] ?? ' ');
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0) {
      if (start < 0 && upper.startsWith('SELECT', i) && !isWord(i - 1) && !isWord(i + 6)) { start = i + 6; i += 5; continue; }
      if (start >= 0 && upper.startsWith('FROM', i) && !isWord(i - 1) && !isWord(i + 4)) { end = i; break; }
    }
  }
  if (start < 0) throw new Error('brak zewnętrznego SELECT');
  if (end < 0) end = src.length; // SELECT z samych podzapytań skalarnych nie ma FROM (T-SQL to dopuszcza)
  const list = src.slice(start, end).replace(/^\s*(TOP\s+\d+|DISTINCT)\s+/i, '');
  const items = [];
  let cur = '';
  depth = 0;
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { items.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') items.push(cur.trim());
  return items;
}

describe('AGGREGATES — bramki statyczne', () => {
  it('lista jest niepusta, id unikatowe, kind/shape z dozwolonych zbiorów, tytuły po polsku', () => {
    expect(AGGREGATES.length).toBeGreaterThanOrEqual(20);
    const ids = AGGREGATES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of AGGREGATES) {
      expect(KINDS, a.id).toContain(a.kind);
      expect(SHAPES, a.id).toContain(a.shape);
      expect(a.title.length, a.id).toBeGreaterThan(10);
      expect(typeof a.sql, a.id).toBe('string');
    }
  });

  it('każde zapytanie przechodzi checkReadOnly (pojedynczy SELECT/WITH, zero DML, zero kolumn osobowych)', () => {
    for (const a of AGGREGATES) expect(checkReadOnly(a.sql), a.id).toEqual({ ok: true });
  });

  it('każde zawiera funkcję agregującą i ma GROUP BY albo zwraca jeden wiersz (wszystkie pozycje zewnętrznego SELECT agregowane)', () => {
    for (const a of AGGREGATES) {
      expect(a.sql, a.id).toMatch(AGG_FN);
      if (a.shape === 'grouped') {
        expect(a.sql, a.id).toMatch(/\bGROUP\s+BY\b/i);
      } else {
        expect(depthZero(a.sql), `${a.id}: shape single nie może mieć GROUP BY na poziomie zewnętrznym`).not.toMatch(/\bGROUP\s+BY\b/i);
        const items = outerSelectItems(a.sql);
        expect(items.length, a.id).toBeGreaterThan(0);
        for (const item of items) expect(item, `${a.id}: pozycja bez agregatu: ${item}`).toMatch(AGG_FN);
      }
    }
  });

  it('żadne nie odwołuje się do nazw/adresów/NIP/PESEL/e-maili/telefonów poza etykietami pól, grup i magazynów', () => {
    for (const a of AGGREGATES) {
      expect(a.sql.replace(ALLOWED_LABELS, 'label'), a.id).not.toMatch(PII_WORDS);
      expect(a.sql, a.id).not.toMatch(/kh_Symbol|kh_Imie|kh_Nazwisko|adr__Ewid|adr_|kh_Uwagi|dok_Uwagi|kh_EMail|kh_WWW/);
    }
  });

  it('kind people deklaruje kColumns, a każda z nich jest aliasem w SQL; tylko people liczą kontrahentów', () => {
    for (const a of AGGREGATES) {
      if (a.kind === 'people') {
        expect(a.kColumns?.length, a.id).toBeGreaterThan(0);
        for (const c of a.kColumns) expect(a.sql, `${a.id}: brak aliasu ${c}`).toMatch(new RegExp(`\\bAS\\s+${c}\\b`));
      } else {
        expect(a.kColumns, a.id).toBeUndefined();
        expect(a.sql, `${a.id}: zapytanie na kh__Kontrahent musi mieć kind people`).not.toMatch(/kh__Kontrahent|kh_CechaKh/);
      }
    }
  });

  it('nigdzie nie ma adresu hosta ani nazwy instancji', () => {
    for (const a of AGGREGATES) {
      expect(a.sql, a.id).not.toMatch(HOST_WORDS);
      expect(a.title, a.id).not.toMatch(HOST_WORDS);
    }
  });

  it('kody typów dokumentów: sprzedaż = FS/PA, zakup = FZ/PZ (dokumentacja InsERT modul-dok)', () => {
    expect(SALES_DOC_TYPES.map((t) => DOC_TYPES[t])).toEqual(['FS', 'PA']);
    expect(PURCHASE_DOC_TYPES.map((t) => DOC_TYPES[t])).toEqual(['FZ', 'PZ']);
    const roles = AGGREGATES.find((a) => a.id === 'contractors_by_document_role');
    expect(roles.sql).toContain('dok_Typ IN (2, 21)');
    expect(roles.sql).toContain('dok_Typ IN (1, 10)');
  });

  it('pokrywa wymagany zakres (a–f)', () => {
    for (const id of [
      'contractors_total', 'contractors_by_person', 'contractors_by_retail_and_person', 'contractors_by_document_role', 'contractor_groups_and_features',
      'products_total', 'products_by_kind', 'products_by_blocked', 'products_default_supplier', 'products_by_brand', 'products_sales_channels',
      'documents_by_type_year', 'documents_by_month', 'documents_date_range',
      'suppliers_default_count', 'suppliers_product_coverage_by_rank', 'purchase_invoices_by_supplier_rank',
      'product_field_labels', 'product_custom_field_usage', 'contractor_field_labels', 'contractor_custom_field_usage',
      'documents_by_warehouse',
    ]) expect(AGGREGATES.some((a) => a.id === id), id).toBe(true);
  });
});

describe('k-anonimizacja', () => {
  it('suppressSmallCounts zastępuje liczniki < k (także 0) przez "<k", nie rusza kluczy, innych kolumn ani k i większych', () => {
    const rows = [
      { is_person: 1, contractor_count: 3, other: 2 },
      { is_person: 0, contractor_count: 10, other: 1 },
      { is_person: 2, contractor_count: 0, other: null },
      { is_person: 3, contractor_count: '<k', other: 'x' },
    ];
    const out = suppressSmallCounts(rows, 10, ['contractor_count']);
    expect(out.map((r) => r.contractor_count)).toEqual(['<k', 10, '<k', '<k']);
    expect(out.map((r) => r.is_person)).toEqual([1, 0, 2, 3]);
    expect(out.map((r) => r.other)).toEqual([2, 1, null, 'x']);
    expect(rows[0].contractor_count).toBe(3); // czysta funkcja — wejście nietknięte
    expect(() => suppressSmallCounts(rows, 0, ['contractor_count'])).toThrow(/k musi/);
    expect(() => suppressSmallCounts(rows, 2.5, ['contractor_count'])).toThrow(/k musi/);
  });

  it('applyKAnonymity: people → tylko kColumns; brak kColumns → wszystkie liczby (fail-closed); inne kind → bez zmian', () => {
    const rows = [{ key: 1, n: 4, m: 40 }];
    expect(applyKAnonymity({ kind: 'people', kColumns: ['n'] }, rows, 10)).toEqual([{ key: 1, n: '<k', m: 40 }]);
    expect(applyKAnonymity({ kind: 'people' }, rows, 10)).toEqual([{ key: '<k', n: '<k', m: 40 }]);
    expect(applyKAnonymity({ kind: 'products' }, rows, 10)).toEqual(rows);
    expect(applyKAnonymity({ kind: 'documents' }, rows, 10)).toBe(rows);
  });

  it('plainRows: daty → YYYY-MM-DD, bigint → Number, binaria → null', () => {
    const rows = plainRows([{ d: new Date('2026-03-05T00:00:00Z'), b: 7n, buf: Buffer.from('x'), n: 1, s: 'a', z: null }]);
    expect(rows).toEqual([{ d: '2026-03-05', b: 7, buf: null, n: 1, s: 'a', z: null }]);
  });
});

describe('dostawcy — filtr formy prawnej i bramki', () => {
  it('akceptuje osoby prawne / spółki rejestrowe', () => {
    for (const name of [
      'X Sp. z o.o.', 'Y GmbH', 'ALFA sp. z o. o.', 'Beta Sp.z o.o. Sp. k.', 'Gamma S.A.', 'Delta Spółka Akcyjna',
      'Signify Poland Sp. z o.o.', 'OSRAM AG', 'Fagerhult AB', 'Helvar Oy', 'Lumen Ltd', 'Lumen Limited', 'Nordic LLC',
      'Lighting Inc.', 'Lumina S.r.l.', 'Lumina SRL', 'Milano S.p.A.', 'Philips B.V.', 'Praha s.r.o.', 'Brno a.s.',
      'Kowalski i Wspólnicy sp. j.', 'Zeta S.K.A.', 'Omega spółka z ograniczoną odpowiedzialnością',
    ]) expect(isLegalEntityName(name), name).toBe(true);
    expect(matchLegalForm('X Sp. z o.o.')).toBe('sp. z o.o.');
    expect(matchLegalForm('Y GmbH')).toBe('GmbH');
  });

  it('odrzuca osoby fizyczne, jednoosobowe działalności i fałszywe trafienia w środku wyrazów', () => {
    for (const name of [
      'Jan Kowalski Handel', 'FHU Nowak', 'P.P.H.U. Kowalski', 'Zakład Elektryczny Anna Nowak', 'Zinc Products', 'Kebab House',
      'Toys Boys', 'Agnieszka Nowak', 'Firma Handlowa Schwab', 'Hurtownia Oświetlenia Jan Nowak', '', '   ', null, undefined,
    ]) expect(isLegalEntityName(name), String(name)).toBe(false);
    expect(LEGAL_FORM_RULE).toMatch(/kh_Osoba = 0/);
    expect(LEGAL_FORM_RULE).toMatch(/GmbH/);
  });

  it('zapytania counts/brands przechodzą checkReadOnly wprost; names TYLKO z zamaskowaną kolumną nazwy', () => {
    expect(checkReadOnly(SUPPLIER_QUERIES.counts)).toEqual({ ok: true });
    expect(checkReadOnly(SUPPLIER_QUERIES.brands)).toEqual({ ok: true });
    const direct = checkReadOnly(SUPPLIER_QUERIES.names);
    expect(direct.ok).toBe(false);
    expect(direct.reason).toMatch(/osobow/i);
    expect(checkReadOnlyExcept(SUPPLIER_QUERIES.names, NAMES_QUERY_MASKED_IDENTIFIERS)).toEqual({ ok: true });
    // Same kolumny nazwy nie wystarczą — adr_TypAdresu (kod int) to znany fałszywy alarm bramki, maskowany osobno.
    expect(checkReadOnlyExcept(SUPPLIER_QUERIES.names, SANCTIONED_NAME_COLUMNS).reason).toMatch(/adr_TypAdresu/);
    expect(SANCTIONED_NAME_COLUMNS).toEqual(['adr_NazwaPelna', 'adr_Nazwa']);
    expect(GATE_FALSE_POSITIVES).toEqual(['adr_TypAdresu']);
    expect(NAMES_QUERY_MASKED_IDENTIFIERS).toEqual(['adr_NazwaPelna', 'adr_Nazwa', 'adr_TypAdresu']);
    expect(SUPPLIER_QUERIES.names).toMatch(/kh_Osoba = 0/);
    expect(SUPPLIER_QUERIES.names).toMatch(/adr_TypAdresu = 1/);
    for (const q of Object.values(SUPPLIER_QUERIES)) expect(q).not.toMatch(HOST_WORDS);
  });

  it('checkReadOnlyExcept nadal blokuje inne kolumny osobowe, `*` na tabeli osobowej i DML', () => {
    const M = NAMES_QUERY_MASKED_IDENTIFIERS;
    expect(checkReadOnlyExcept('SELECT adr_NazwaPelna, adr_NIP FROM adr__Ewid', M).ok).toBe(false);
    expect(checkReadOnlyExcept('SELECT adr_Nazwa, adr_Ulica FROM adr__Ewid', M).ok).toBe(false);
    expect(checkReadOnlyExcept('SELECT adr_Nazwa, adr_Adres FROM adr__Ewid', M).ok).toBe(false);
    expect(checkReadOnlyExcept('SELECT * FROM adr__Ewid', M).ok).toBe(false);
    expect(checkReadOnlyExcept('SELECT a.* FROM adr__Ewid a WHERE adr_TypAdresu = 1', M).ok).toBe(false);
    expect(checkReadOnlyExcept('UPDATE adr__Ewid SET adr_Nazwa = 1', M).ok).toBe(false);
    expect(checkReadOnlyExcept('SELECT adr_Nazwa FROM adr__Ewid; DROP TABLE x', M).ok).toBe(false);
    expect(checkReadOnlyExcept('SELECT kh_Nazwisko FROM kh__Kontrahent', M).ok).toBe(false);
    expect(checkReadOnlyExcept('SELECT adr_Nazwa FROM adr__Ewid WHERE adr_TypAdresu = 1', M)).toEqual({ ok: true });
  });

  it('buildSupplierList zostawia tylko osoby prawne, liczy odrzuconych, marki TOP 5 wg liczby towarów, sortuje po liczbie towarów', () => {
    const counts = [
      { supplier_id: 1, product_count: 5 },
      { supplier_id: 2, product_count: 50 },
      { supplier_id: 3, product_count: 7 },
      { supplier_id: 4, product_count: 1 },
    ];
    const brands = [
      { supplier_id: 2, brand: 'B1', product_count: 20 }, { supplier_id: 2, brand: 'B2', product_count: 10 },
      { supplier_id: 2, brand: 'B3', product_count: 8 }, { supplier_id: 2, brand: 'B4', product_count: 6 },
      { supplier_id: 2, brand: 'B5', product_count: 4 }, { supplier_id: 2, brand: 'B6', product_count: 2 },
      { supplier_id: 2, brand: null, product_count: 1 }, { supplier_id: 1, brand: 'Podstawowa', product_count: 5 },
    ];
    const names = [
      { supplier_id: 1, display_name: 'Alfa Sp. z o.o.' },
      { supplier_id: 2, display_name: 'Beta GmbH' },
      { supplier_id: 2, display_name: 'Beta GmbH (duplikat adresu)' },
      { supplier_id: 3, display_name: 'Jan Kowalski Handel' },
    ];
    const { suppliers, stats } = buildSupplierList({ counts, brands, names });
    expect(stats).toEqual({ candidates: 4, kept: 2, droppedNaturalPersons: 1, unnamed: 1 });
    expect(suppliers).toEqual([
      { name: 'Beta GmbH', productCount: 50, brands: ['B1', 'B2', 'B3', 'B4', 'B5'] },
      { name: 'Alfa Sp. z o.o.', productCount: 5, brands: ['Podstawowa'] },
    ]);
    expect(JSON.stringify(suppliers)).not.toContain('Kowalski');
  });
});
