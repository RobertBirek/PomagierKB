import { describe, expect, it } from 'vitest';
import { isDictionaryTable, safeColumns, selectDictionary, MAX_ROWS } from '../src/queries-data.mjs';

describe('mssql-introspect: odczyt słowników — bramki', () => {
  it('tylko sl_* w limicie wierszy; wykluczone tabele osobowe i rejestry publiczne', () => {
    expect(isDictionaryTable('sl_StawkaVAT', 14)).toBe(true);
    expect(isDictionaryTable('sl_Uzytkownik', 5)).toBe(false);
    expect(isDictionaryTable('sl_KodPocztowy', 100)).toBe(false);
    expect(isDictionaryTable('sl_Bank', 20)).toBe(false);
    expect(isDictionaryTable('kh__Kontrahent', 3)).toBe(false);
    expect(isDictionaryTable('sl_Zawod', 10)).toBe(false);
    expect(isDictionaryTable('sl_StawkaVAT', MAX_ROWS + 1)).toBe(false);
    expect(isDictionaryTable('sl_StawkaVAT', 0)).toBe(false);
  });
  it('kolumny osobowe/uwierzytelniające są odrzucane', () => {
    expect(safeColumns(['vat_Id', 'vat_Nazwa', 'uz_Haslo', 'kh_NIP', 'adr_Email', 'pr_Nazwisko', 'pr_DataUr', 'rk_Konto', 'x_Login'])).toEqual(['vat_Id', 'vat_Nazwa']);
  });
  it('zapytanie to SELECT TOP z cytowanymi nazwami, bez DML', () => {
    const sql = selectDictionary('pomagier', 'dbo', 'sl_StawkaVAT', ['vat_Id', 'vat_Nazwa', 'uz_Haslo']);
    expect(sql).toBe(`SELECT TOP ${MAX_ROWS} [vat_Id], [vat_Nazwa] FROM [pomagier].[dbo].[sl_StawkaVAT]`);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|EXEC)\b/i);
    expect(() => selectDictionary('pomagier', 'dbo', 'kh__Kontrahent', ['kh_Id'])).toThrow(/allowlisty/);
    expect(() => selectDictionary('pomagier', 'dbo', 'sl_X', ['uz_Haslo'])).toThrow(/bezpiecznych kolumn/);
  });
});
