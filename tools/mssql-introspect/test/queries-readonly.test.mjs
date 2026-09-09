import { describe, expect, it } from 'vitest';
import { ALL_QUERIES, FINGERPRINT_TABLES, quoteName } from '../src/queries.mjs';
import { configFromEnv, describeTarget, parseEnvFile } from '../src/env.mjs';
import { fingerprint } from '../src/fingerprint.mjs';
import { buildCatalog } from '../src/catalog.mjs';

describe('mssql-introspect: read-only przez konstrukcję', () => {
  const dml = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|EXEC|EXECUTE|GRANT|DENY|REVOKE|BULK|OPENROWSET|xp_|sp_)\b/i;
  it('żadne zapytanie nie zawiera DML/DDL ani procedur', () => {
    for (const [name, q] of Object.entries(ALL_QUERIES)) {
      expect(q, name).not.toMatch(dml);
    }
  });
  it('każde FROM/JOIN odwołuje się wyłącznie do sys.* albo INFORMATION_SCHEMA', () => {
    for (const [name, q] of Object.entries(ALL_QUERIES)) {
      const refs = [...q.matchAll(/\b(?:FROM|JOIN)\s+([^\s(]+)/gi)].map((m) => m[1]);
      if (name !== 'SERVER_INFO') expect(refs.length, name).toBeGreaterThan(0); // SERVER_INFO to same funkcje serwera, bez FROM
      for (const r of refs) {
        expect(r, `${name}: ${r}`).toMatch(/^(\[x\]\.)?(sys\.|INFORMATION_SCHEMA\.)/);
      }
    }
  });
  it('quoteName cytuje jak QUOTENAME i odrzuca śmieci', () => {
    expect(quoteName('pomagier')).toBe('[pomagier]');
    expect(quoteName('a]b')).toBe('[a]]b]');
    expect(() => quoteName('')).toThrow();
    expect(() => quoteName('x'.repeat(129))).toThrow();
  });
});

describe('mssql-introspect: env i odcisk', () => {
  it('parsuje plik env, wymaga hosta/usera/hasła i nie ujawnia hasła w opisie', () => {
    const env = parseEnvFile('# c\nMSSQL_HOST=10.0.0.1\nMSSQL_PORT=49604\nMSSQL_USER="sa"\nMSSQL_PASSWORD=\'tajne\'\n');
    const cfg = configFromEnv(env, 'test');
    expect(cfg.port).toBe(49604);
    expect(cfg.options.readOnlyIntent).toBe(true);
    expect(describeTarget(cfg)).toBe('sa@10.0.0.1:49604');
    expect(describeTarget(cfg)).not.toContain('tajne');
    expect(() => configFromEnv({ MSSQL_HOST: 'h' }, 't')).toThrow(/niekompletne/);
    expect(() => configFromEnv({ MSSQL_HOST: 'h', MSSQL_USER: 'u', MSSQL_PASSWORD: 'p', MSSQL_PORT: '99999' }, 't')).toThrow(/MSSQL_PORT/);
  });
  it('rozpoznaje InsERT GT i Optima po tabelach', () => {
    expect(fingerprint(['tw__Towar', 'dok__Dokument', 'kh__Kontrahent', 'x']).product).toBe('insertGt');
    expect(fingerprint(FINGERPRINT_TABLES.comarchOptima.slice(0, 4)).product).toBe('comarchOptima');
    expect(fingerprint(['a', 'b']).product).toBe('unknown');
  });
});

describe('mssql-introspect: buildCatalog', () => {
  it('składa kolumny, klucze, FK w obie strony, indeksy i liczności (bez modułów kadrowych)', () => {
    const cat = buildCatalog({ database: 'd' }, {
      aliasTypes: [{ typeName: 'TNazwa', baseTypeName: 'varchar', maxLength: 50, precision: 0, scale: 0 }],
      tables: [{ schemaName: 'dbo', tableName: 'tw__Towar' }, { schemaName: 'dbo', tableName: 'sl_Grupa' }, { schemaName: 'dbo', tableName: 'pr_Pracownik' }],
      columns: [
        { schemaName: 'dbo', tableName: 'tw__Towar', columnName: 'tw_Id', typeName: 'int', maxLength: 4, precision: 10, scale: 0, isNullable: false, isIdentity: true },
        { schemaName: 'dbo', tableName: 'tw__Towar', columnName: 'tw_Nazwa', typeName: 'TNazwa', maxLength: 50, precision: 0, scale: 0, isNullable: false, defaultDefinition: "('')" },
        { schemaName: 'dbo', tableName: 'tw__Towar', columnName: 'tw_IdGrupa', typeName: 'int', maxLength: 4, precision: 10, scale: 0, isNullable: true },
        { schemaName: 'dbo', tableName: 'sl_Grupa', columnName: 'gr_Id', typeName: 'int', maxLength: 4, precision: 10, scale: 0, isNullable: false },
      ],
      keys: [{ schemaName: 'dbo', tableName: 'tw__Towar', constraintName: 'PK_tw', kind: 'PK', ordinal: 1, columnName: 'tw_Id' }],
      foreignKeys: [{ constraintName: 'FK_tw_gr', schemaName: 'dbo', tableName: 'tw__Towar', columnName: 'tw_IdGrupa', refSchemaName: 'dbo', refTableName: 'sl_Grupa', refColumnName: 'gr_Id', ordinal: 1, onDelete: 'NO_ACTION', onUpdate: 'NO_ACTION' }],
      indexes: [{ schemaName: 'dbo', tableName: 'tw__Towar', indexName: 'IX_n', typeDesc: 'NONCLUSTERED', isUnique: false, isPrimaryKey: false, ordinal: 1, isIncluded: false, columnName: 'tw_Nazwa' }],
      rowCounts: [{ schemaName: 'dbo', tableName: 'tw__Towar', rowsCount: 7 }, { schemaName: 'dbo', tableName: 'pr_Pracownik', rowsCount: 3 }],
      parameters: [{ schemaName: 'dbo', objectName: 'p', ordinal: 1, paramName: '@a', typeName: 'TNazwa', maxLength: 50, precision: 0, scale: 0, isOutput: false }],
      modules: [{ schemaName: 'dbo', objectName: 'p', typeDesc: 'SQL_STORED_PROCEDURE', definition: null }],
    });
    const t = cat.tables['dbo.tw__Towar'];
    expect(t.columns[1].type).toBe('TNazwa (varchar(50))');
    expect(t.pk).toEqual(['tw_Id']);
    expect(t.fks[0].refTable).toBe('dbo.sl_Grupa');
    expect(cat.tables['dbo.sl_Grupa'].referencedBy[0].fromTable).toBe('dbo.tw__Towar');
    expect(t.indexes[0].cols).toEqual(['tw_Nazwa']);
    expect(t.rows).toBe(7);
    expect(cat.tables['dbo.pr_Pracownik'].rows).toBeNull();
    expect(cat.modules[0].params[0].type).toBe('TNazwa (varchar(50))');
    expect(cat.aliasTypes).toEqual({ tnazwa: 'varchar(50)' });
  });
});
