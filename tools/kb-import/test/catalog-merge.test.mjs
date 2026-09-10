import { describe, expect, it } from 'vitest';
import { emptyCatalog, ensureTable } from '../lib/catalog-md.mjs';
import { mergeDocsIntoCatalog, renderDiff, typesCompatible } from '../lib/catalog-merge.mjs';
import { parseDbChangesXml, parseDbDocXml, renderDbChanges } from '../lib/insert-dbdoc.mjs';
import { attachDefinitions, objectKeyFromFile, stripScriptWrapper } from '../lib/sql-scripts.mjs';

describe('catalog-merge: typesCompatible', () => {
  it('normalizuje spacje, aliasy, (max)/(-1) i długości typów bez parametru', () => {
    expect(typesCompatible('varchar(255)', 'varchar (255)')).toBe(true);
    expect(typesCompatible('TNazwa (varchar(50))', 'varchar (50)')).toBe(true);
    expect(typesCompatible('TNazwa (varchar(50))', 'tnazwa')).toBe(true);
    expect(typesCompatible('varchar(max)', 'varchar (-1)')).toBe(true);
    expect(typesCompatible('ntext', 'ntext (1073741823)')).toBe(true);
    expect(typesCompatible('int', 'varchar (10)')).toBe(false);
    expect(typesCompatible('varchar(50)', 'varchar (60)')).toBe(false);
  });
});

const DOC_XML = `<?xml version="1.0"?><SQLDB><Name>x</Name><Date>15.07.2026</Date><Version>1.89</Version><Generator>G</Generator>
<Table ready="1"><Name>tw__Towar</Name><Author>KB</Author><Description>Towary</Description>
 <Field><Name>tw_Id</Name><Description>Identyfikator</Description><TypeDescription>int</TypeDescription></Field>
 <Field><Name>tw_Stara</Name><Description>Usunięta</Description><TypeDescription>int</TypeDescription></Field>
 <Index><Keys>tw_Id</Keys></Index>
 <Constraint><Name>PK_tw</Name><TypeDescription>PRIMARY KEY</TypeDescription></Constraint>
 <Alert level="1">pole bez relacji: [tw_X]</Alert></Table>
<Table><Name>tylko_doc</Name><Field><Name>a</Name><TypeDescription>int</TypeDescription></Field></Table></SQLDB>`;

describe('insert-dbdoc + merge', () => {
  it('parsuje XML dokumentacji i nakłada opisy, licząc różnice', () => {
    const docs = parseDbDocXml(DOC_XML);
    expect(docs.version).toBe('1.89');
    expect(docs.tables['tw__Towar'].fields.length).toBe(2);
    expect(docs.tables['tw__Towar'].constraints[0]).toEqual({ name: 'PK_tw', kind: 'PRIMARY KEY', reference: null, columns: null });
    const cat = emptyCatalog({ database: 'db' });
    const t = ensureTable(cat, 'dbo', 'tw__Towar');
    t.columns.push({ name: 'tw_Id', type: 'int', nullable: false }, { name: 'tw_Nowa', type: 'int', nullable: true });
    ensureTable(cat, 'dbo', 'tylko_live');
    const diff = mergeDocsIntoCatalog(cat, docs);
    expect(t.description).toBe('Towary');
    expect(t.columns[0].description).toBe('Identyfikator');
    expect(diff.docsOnlyTables).toEqual(['tylko_doc']);
    expect(diff.liveOnlyTables).toEqual(['dbo.tylko_live']);
    expect(diff.docsOnlyColumns).toEqual([{ table: 'tw__Towar', column: 'tw_Stara', type: 'int' }]);
    expect(diff.liveOnlyColumns).toEqual([{ table: 'tw__Towar', column: 'tw_Nowa', type: 'int' }]);
    expect(diff.alerts.length).toBe(1);
    const md = renderDiff(diff, { productLabel: 'InsERT GT', database: 'db', sourceName: 'host' });
    expect(md).toContain('- `tylko_doc`');
    expect(md).toContain('`tw__Towar.tw_Nowa` (int)');
    expect(md).toContain('pole bez relacji: […] — 1 wystąpień');
  });
  it('parsuje i renderuje dokumentację zmian', () => {
    const xml = `<DBDiff><OldVersion>1.0</OldVersion><NewVersion>1.1</NewVersion><Date>d</Date><NewTabs></NewTabs><DeletedTabs></DeletedTabs>
      <ChangedTabs><Table><Name>vat__EwidVAT</Name><Desc>Ewidencje VAT</Desc><Fields><Field><Name>ev_X</Name><Type>datetime</Type><Desc>opis</Desc><State>NEW</State><OldType></OldType></Field></Fields></Table></ChangedTabs></DBDiff>`;
    const ch = parseDbChangesXml(xml);
    expect(ch.changedTables[0].fields[0]).toEqual({ name: 'ev_X', type: 'datetime', description: 'opis', state: 'NEW', oldType: null });
    const md = renderDbChanges(ch);
    expect(md).toContain('# InsERT GT — zmiany w bazie danych 1.0 → 1.1');
    expect(md).toContain('  - `ev_X` — datetime — opis [NEW]');
    expect(md).toContain('**Nowe tabele:** brak.');
    expect(md).not.toMatch(/^##/m);
  });
});

describe('sql-scripts', () => {
  it('zdejmuje opakowanie SET/GO i mapuje nazwę pliku na klucz obiektu', () => {
    expect(stripScriptWrapper('SET QUOTED_IDENTIFIER ON\nGO\nSET ANSI_NULLS ON\nGO\nCREATE VIEW v AS SELECT 1\nGO\n')).toBe('CREATE VIEW v AS SELECT 1');
    expect(objectKeyFromFile('dbo.vwTowary.sql')).toBe('dbo.vwTowary');
    expect(objectKeyFromFile('InsSearch.idx_tw__Towar.sql')).toBe('InsSearch.idx_tw__Towar');
    expect(objectKeyFromFile('readme.txt')).toBeNull();
  });
  it('attachDefinitions wstrzykuje definicje tylko tam, gdzie ich brak', () => {
    const cat = { modules: [{ schema: 'dbo', name: 'A', definition: null }, { schema: 'dbo', name: 'B', definition: 'x' }, { schema: 'dbo', name: 'C', definition: null }] };
    const defs = new Map([['dbo.a', { definition: 'CREATE VIEW A', file: 'Views/dbo.A.sql' }]]);
    expect(attachDefinitions(cat, defs)).toEqual({ matched: 1, missing: 1, alreadyHad: 1 });
    expect(cat.modules[0].definition).toBe('CREATE VIEW A');
  });
});
