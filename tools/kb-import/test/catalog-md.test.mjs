import { describe, expect, it } from 'vitest';
import { emptyCatalog, ensureTable, formatSqlType, groupByModule, modulePrefix, packSections, renderModule, renderTable, splitLargeSection } from '../lib/catalog-md.mjs';

describe('catalog-md: typy i prefiksy', () => {
  it('formatuje typy SQL Server z metadanych', () => {
    expect(formatSqlType('nvarchar', 100, 0, 0)).toBe('nvarchar(50)');
    expect(formatSqlType('nvarchar', -1, 0, 0)).toBe('nvarchar(max)');
    expect(formatSqlType('varchar', 20, 0, 0)).toBe('varchar(20)');
    expect(formatSqlType('decimal', 9, 18, 2)).toBe('decimal(18,2)');
    expect(formatSqlType('int', 4, 10, 0)).toBe('int');
    expect(formatSqlType('datetime2', 8, 27, 3)).toBe('datetime2(3)');
  });
  it('prefiks modułu z nazwy tabeli InsERT GT', () => {
    expect(modulePrefix('tw__Towar')).toBe('tw');
    expect(modulePrefix('sl_Uzytkownik')).toBe('sl');
    expect(modulePrefix('__Tabele')).toBe('inne');
    expect(modulePrefix('Towary')).toBe('inne');
  });
});

function sampleTable() {
  const c = emptyCatalog({ database: 'x' });
  const t = ensureTable(c, 'dbo', 'tw__Towar');
  t.description = 'Towary';
  t.columns.push({ name: 'tw_Id', type: 'int', nullable: false, identity: true, computed: null, default: null, description: 'Id' });
  t.columns.push({ name: 'tw_Nazwa', type: 'TNazwa (varchar(50))', nullable: false, identity: false, computed: null, default: "('')", description: null });
  t.pk = ['tw_Id'];
  t.fks.push({ name: 'FK_x', cols: ['tw_IdGrupa'], refTable: 'dbo.sl_GrupaTw', refCols: ['grt_Id'], onDelete: 'NO_ACTION', onUpdate: 'NO_ACTION' });
  t.indexes.push({ name: 'IX_1', type: 'NONCLUSTERED', unique: false, primaryKey: false, cols: ['tw_Nazwa'], includes: [], filter: null });
  t.rows = 1234;
  return c;
}

describe('catalog-md: render tabeli', () => {
  it('kolumny jako lista, klucze, indeksy, liczność; bez samotnych liczb w osobnych liniach', () => {
    const c = sampleTable();
    const md = renderTable(c.tables['dbo.tw__Towar']);
    expect(md).toContain('### dbo.tw__Towar');
    expect(md).toContain('- `tw_Id` — int, NOT NULL, identity, PK — Id');
    expect(md).toContain("- `tw_Nazwa` — TNazwa (varchar(50)), NOT NULL, domyślnie ('')");
    expect(md).toContain('Klucz główny: `tw_Id`.');
    expect(md).toContain('Klucz obcy FK_x: `tw_IdGrupa` → dbo.sl_GrupaTw(grt_Id).');
    expect(md).toContain('- IX_1 (nonclustered): tw_Nazwa');
    expect(md).toContain('Liczba wierszy (z metadanych partycji): 1234.');
    expect(md.split('\n').some((l) => /^\d{1,4}$/.test(l.trim()))).toBe(false);
  });
  it('grupuje po module', () => {
    const c = sampleTable();
    ensureTable(c, 'dbo', 'sl_GrupaTw');
    const g = groupByModule(c);
    expect([...g.keys()]).toEqual(['sl', 'tw']);
  });
  it('moduł bez definicji dostaje jawną notkę o szyfrowaniu', () => {
    const md = renderModule({ schema: 'dbo', name: 'p1', type: 'SQL_STORED_PROCEDURE', params: [{ name: '@a', type: 'int', output: false }], definition: null });
    expect(md).toContain('### Procedura składowana dbo.p1');
    expect(md).toContain('- `@a` — int');
    expect(md).toContain('Definicja niedostępna');
  });
  it('definicja jest przycinana do limitu z adnotacją', () => {
    const md = renderModule({ schema: 'dbo', name: 'v', type: 'VIEW', params: [], definition: 'SELECT ' + 'x'.repeat(5000) }, 100);
    expect(md).toContain('(definicja przycięta do 100 znaków z 5007)');
  });
});

describe('catalog-md: packSections', () => {
  it('pakuje sekcje do części ≤ maxChars z nagłówkiem, streszczeniem i numeracją', () => {
    const sections = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, text: `### s${i}\n${'a'.repeat(300)}\n` }));
    const packed = packSections(sections, { title: 'T', intro: 'Intro.', maxChars: 1000, keywords: ['k'] });
    expect(packed.length).toBeGreaterThan(1);
    expect(packed[0].title).toBe(`T (część 1/${packed.length})`);
    expect(packed[0].text.startsWith(`# T (część 1/${packed.length})\n\nIntro.\n\nZawartość tej części: s0, s1, s2.\nSłowa kluczowe: k.`)).toBe(true);
    expect(packed.flatMap((p) => p.names)).toEqual(sections.map((s) => s.name));
  });
  it('jedna sekcja → bez sufiksu części', () => {
    const packed = packSections([{ name: 'a', text: 'x' }], { title: 'T', intro: 'I' });
    expect(packed[0].title).toBe('T');
    expect(packed[0].parts).toBe(1);
  });
  it('sekcja większa niż limit jest dzielona po nagłówkach, potem po akapitach', () => {
    const big = { name: 'B', text: '## A\n' + 'p\n\n'.repeat(400) + '## C\n' + 'q\n\n'.repeat(400) };
    const parts = splitLargeSection(big, 500);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.text.length <= 502)).toBe(true);
    expect(parts.map((p) => p.text).join('')).toContain('## C');
    const packed = packSections([big], { title: 'T', intro: 'I', maxChars: 500 });
    expect(packed.length).toBe(parts.length);
  });
});

describe('catalog-md: liczności opcjonalne', () => {
  it('rows:false pomija linię „Liczba wierszy" (zrzut z bazy demo nie może udawać faktów o firmie)', () => {
    const cat = emptyCatalog({ database: 'db' });
    const t = ensureTable(cat, 'dbo', 'tw__Towar');
    t.rows = 577;
    t.columns.push({ name: 'tw_Id', type: 'int', nullable: false });
    expect(renderTable(t)).toContain('Liczba wierszy');
    expect(renderTable(t, { rows: false })).not.toContain('Liczba wierszy');
  });
});
