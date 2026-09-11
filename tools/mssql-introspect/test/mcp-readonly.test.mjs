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

describe('checkReadOnly — deny-lista danych osobowych (decyzja 2026-09-11)', () => {
  it('odrzuca projekcję kolumn osobowych, niezależnie od tabeli i aliasu', () => {
    for (const q of [
      'SELECT kh_Symbol FROM kh__Kontrahent',
      'SELECT k.kh_Nazwa FROM kh__Kontrahent k',
      'SELECT adr_NazwaPelna, adr_Ulica FROM adr__Ewid',
      'SELECT adr_NIP FROM adr__Ewid',
      'SELECT kh_EMail FROM kh__Kontrahent',
      'SELECT pk_Telefon FROM kh_Pracownik',
      'SELECT pr_Nazwisko FROM pr_Pracownik',
      'SELECT pr_PESEL FROM pr_Pracownik',
      'SELECT dok_Uwagi FROM dok__Dokument',
      'SELECT ev_NazwaKh FROM vat__EwidVAT',
      'SELECT uz_Login, uz_Haslo FROM pd_Uzytkownik',
      'SELECT TOP 5 kh_Id FROM kh__Kontrahent ORDER BY kh_Nazwa', // sortowanie po nazwie też ujawnia kolejność nazwisk
    ]) {
      const r = checkReadOnly(q);
      expect(r.ok, q).toBe(false);
      expect(r.reason, q).toMatch(/osobow/i);
    }
  });
  it('odrzuca SELECT * i alias.* na tabelach z danymi osobowymi', () => {
    for (const q of [
      'SELECT * FROM kh__Kontrahent',
      'SELECT TOP 10 k.* FROM kh__Kontrahent k',
      'SELECT * FROM adr__Ewid WHERE adr_Id = 1',
      'SELECT d.dok_Id, k.* FROM dok__Dokument d JOIN kh__Kontrahent k ON k.kh_Id = d.dok_PlatnikId',
      'SELECT * FROM pr_Pracownik',
    ]) {
      const r = checkReadOnly(q);
      expect(r.ok, q).toBe(false);
      expect(r.reason, q).toMatch(/SELECT \*/);
    }
  });
  it('przepuszcza agregaty po flagach/id kontrahentów i zwykłe dane towarowo-dokumentowe', () => {
    for (const q of [
      'SELECT COUNT(*) FROM kh__Kontrahent WHERE kh_Osoba = 1',
      'SELECT kh_OdbDet, COUNT(*) AS n FROM kh__Kontrahent GROUP BY kh_OdbDet',
      'SELECT COUNT(DISTINCT dok_PlatnikId) FROM dok__Dokument WHERE dok_Typ = 2',
      'SELECT tw_Id, tw_Symbol, tw_Nazwa, tw_IdGrupa FROM tw__Towar WHERE tw_Zablokowany = 0',
      'SELECT grt_Id, grt_Nazwa FROM sl_GrupaTw',
      'SELECT * FROM sl_GrupaTw', // słownik bez danych osobowych — gwiazdka dozwolona
      'SELECT d.dok_Typ, YEAR(d.dok_DataWyst) AS rok, SUM(d.dok_WartNetto) AS netto FROM dok__Dokument d GROUP BY d.dok_Typ, YEAR(d.dok_DataWyst)',
      'SELECT COUNT(*) FROM dok__Dokument d JOIN kh__Kontrahent k ON k.kh_Id = d.dok_PlatnikId WHERE k.kh_Osoba = 0',
      "SELECT tw_Nazwa FROM tw__Towar WHERE tw_Nazwa LIKE '%Kowalski%'", // literał nie jest identyfikatorem
    ]) {
      expect(checkReadOnly(q), q).toEqual({ ok: true });
    }
  });
});
