import { describe, expect, it } from 'vitest';
import { checkReadOnly } from '../src/mcp-readonly.mjs';

describe('checkReadOnly — bramka tylko-do-odczytu serwera MCP mssql', () => {
  it('przepuszcza zwykłe SELECT i CTE, także z komentarzami i średnikiem końcowym', () => {
    expect(checkReadOnly('SELECT TOP 10 * FROM dbo.Towar')).toEqual({ ok: true });
    expect(checkReadOnly('  select tw_Symbol, tw_Nazwa from tw__Towar where tw_Rodzaj=1;').ok).toBe(true);
    expect(checkReadOnly('WITH c AS (SELECT 1 x) SELECT x FROM c').ok).toBe(true);
    expect(checkReadOnly('/* raport */ SELECT COUNT(*) FROM dok__Dokument -- liczba').ok).toBe(true);
  });
  it('odrzuca zapis, DDL, procedury i wiele zapytań', () => {
    for (const q of [
      'UPDATE tw__Towar SET tw_Nazwa=1',
      'delete from dok__Dokument',
      'INSERT INTO x VALUES (1)',
      'DROP TABLE x',
      'ALTER TABLE x ADD c int',
      'TRUNCATE TABLE x',
      'EXEC sp_who',
      'SELECT * INTO nowa FROM tw__Towar',
      'SELECT 1; DROP TABLE x',
      'MERGE t USING s ON t.id=s.id WHEN MATCHED THEN DELETE',
      'DBCC CHECKDB',
      "WAITFOR DELAY '00:00:10'",
    ]) {
      expect(checkReadOnly(q).ok, q).toBe(false);
    }
  });
  it('słowo zabronione UKRYTE w literale lub identyfikatorze nie blokuje odczytu', () => {
    expect(checkReadOnly("SELECT * FROM tw__Towar WHERE tw_Nazwa = 'DROP zestaw'").ok).toBe(true);
    expect(checkReadOnly('SELECT [delete_flag] FROM [update_log]').ok).toBe(true);
  });
  it('puste i nie-SELECT odrzucone', () => {
    expect(checkReadOnly('').ok).toBe(false);
    expect(checkReadOnly('   ').ok).toBe(false);
    expect(checkReadOnly('/* tylko komentarz */').ok).toBe(false);
    expect(checkReadOnly('SET NOCOUNT ON').ok).toBe(false);
  });
});
