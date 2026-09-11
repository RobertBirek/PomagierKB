import { describe, expect, it } from 'vitest';
import { compileOnlyPattern, isDictionaryTable, safeColumns, selectDictionary, MAX_ROWS } from '../src/queries-data.mjs';

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
  it('blacklista kadrowo-płacowa (Gratyfikant): stanowiska, działy, stawki, umowy, absencje, kalendarze, składniki', () => {
    for (const hr of [
      'sl_Stanowisko',
      'sl_StawkaZaszeregowania',
      'sl_Dzial',
      'sl_CrmDzial',
      'sl_GrupaPrac',
      'sl_StawkaProwizyjna',
      'sl_StawkaProwizyjnaProg',
      'sl_SzablonUmowyOPrace',
      'sl_SzablonUmowyCP',
      'sl_Uprawnienie',
      'sl_TypUrlopu',
      'sl_TypAbsencji',
      'sl_WzorzecSkladnikaPlacowego',
      'sl_Kalendarz',
      'sl_KalendDzien',
      'sl_StawkaAkordowa',
      'sl_ZestawAkordowy',
      'sl_GratPrzyczynaRozwUmowy',
      'sl_KodWygasnieciaStosunkuPracy',
      'sl_BadanieOkresowe',
      'sl_KursBHP',
    ]) {
      expect(isDictionaryTable(hr, 5), hr).toBe(false);
    }
    // Zakotwiczenie `dzial$` i wąskie wzorce nie mogą zabierać słowników produktowych/handlowych.
    for (const ok of ['sl_SzablonDzialania', 'sl_FormaDzialaniaWindykacyjnego', 'sl_Oddzialy', 'sl_OddzialMagazyn', 'sl_Magazyn', 'sl_FormaPlatnosci', 'sl_GrupaTw', 'sl_Rabat', 'sl_SzablonRachunku', 'sl_Waluta']) {
      expect(isDictionaryTable(ok, 5), ok).toBe(true);
    }
  });
  it('allow-lista --only zawęża po nazwie tabeli (case-insensitive), ale nie omija blacklisty ani limitów', () => {
    const only = compileOnlyPattern('stawka|MAGAZYN');
    expect(isDictionaryTable('sl_StawkaVAT', 14, only)).toBe(true);
    expect(isDictionaryTable('sl_Magazyn', 3, only)).toBe(true);
    expect(isDictionaryTable('sl_Waluta', 3, only)).toBe(false);
    expect(isDictionaryTable('sl_StawkaZaszeregowania', 3, only)).toBe(false);
    expect(isDictionaryTable('sl_StawkaVAT', MAX_ROWS + 1, only)).toBe(false);
    expect(isDictionaryTable('kh__StawkaX', 3, only)).toBe(false);
    expect(compileOnlyPattern(null)).toBeNull();
    expect(compileOnlyPattern('')).toBeNull();
    expect(isDictionaryTable('sl_Waluta', 3, compileOnlyPattern(undefined))).toBe(true);
    expect(() => compileOnlyPattern('stawka(')).toThrow(/--only/);
  });
  it('kolumny osobowe/uwierzytelniające są odrzucane', () => {
    expect(safeColumns(['vat_Id', 'vat_Nazwa', 'uz_Haslo', 'kh_NIP', 'adr_Email', 'pr_Nazwisko', 'pr_DataUr', 'rk_Konto', 'x_Login'])).toEqual(['vat_Id', 'vat_Nazwa']);
  });
  it('kolumny kontaktowe, linki, dane POS i wolny tekst uwag są odrzucane', () => {
    expect(safeColumns(['mag_Id', 'mag_Symbol', 'mag_Nazwa', 'mag_POSNazwa', 'mag_POSAdres', 'kh_Uwagi', 'so_Link', 'kh_WWW', 'kh_Skype', 'x_Linkowanie'])).toEqual(['mag_Id', 'mag_Symbol', 'mag_Nazwa', 'x_Linkowanie']);
  });
  it('zapytanie to SELECT TOP z cytowanymi nazwami, bez DML', () => {
    const sql = selectDictionary('pomagier', 'dbo', 'sl_StawkaVAT', ['vat_Id', 'vat_Nazwa', 'uz_Haslo']);
    expect(sql).toBe(`SELECT TOP ${MAX_ROWS} [vat_Id], [vat_Nazwa] FROM [pomagier].[dbo].[sl_StawkaVAT]`);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|EXEC)\b/i);
    expect(() => selectDictionary('pomagier', 'dbo', 'kh__Kontrahent', ['kh_Id'])).toThrow(/allowlisty/);
    expect(() => selectDictionary('pomagier', 'dbo', 'sl_X', ['uz_Haslo'])).toThrow(/bezpiecznych kolumn/);
  });
});
