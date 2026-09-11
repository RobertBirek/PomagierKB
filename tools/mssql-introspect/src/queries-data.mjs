// Jedyne miejsce, gdzie narzędzie czyta WIERSZE (nie katalog): małe tabele słownikowe `sl_*`.
// Bramki (test/queries-data.test.mjs): nazwa tabeli z allowlisty prefiksu i spoza blacklisty,
// kolumny bez wzorców danych osobowych, limit wierszy i kolumn, tylko SELECT TOP … (zero DML).
// Rozszerzenie zakresu „metadane" o słowniki jest decyzją właściciela bazy (2026-09-10) i jest
// odnotowane w docs/data-governance.md §1.2.

import { quoteName } from './queries.mjs';

/** Tabele słownikowe: tylko ten prefiks. */
export const DICT_TABLE_RE = /^sl_/i;
/** Użytkownicy/pracownicy/hasła oraz duże rejestry publiczne (szum, nie wiedza o produkcie). */
const BLACKLIST_CORE = 'uzytkownik|pracownik|haslo|osoba|kodpocztowy|kodcn|pkwiu|gmina|bank$|zawod|urzadskarbowy|dystrybutor|kodpkd';
/**
 * Kadry/płace (Gratyfikant): struktura organizacyjna, stawki i akordy, szablony umów, uprawnienia,
 * absencje/urlopy, kalendarze czasu pracy, składniki płacowe, badania/BHP, kody rozwiązania stosunku pracy.
 * `dzial$` celowo zakotwiczone: sl_Dzial/sl_CrmDzial tak, ale nie sl_SzablonDzialania ani sl_Oddzialy.
 */
const BLACKLIST_HR = 'stanowisko|dzial$|grupaprac|stawkazaszereg|stawkaprowiz|szablonumow|uprawnien|urlop|absenc|skladnik\\w{0,2}plac|kalend|akord|^sl_grat|stosunkupracy|badanieokresowe|kursbhp';
/** Tabele wykluczone ze zrzutu wartości (sprawdzane po nazwie tabeli, bez względu na wielkość liter). */
export const DICT_TABLE_BLACKLIST = new RegExp(`(${BLACKLIST_CORE}|${BLACKLIST_HR})`, 'i');
/** Kolumny nigdy nie czytane (dane osobowe / uwierzytelniające / kontaktowe / wolny tekst uwag). */
export const PII_COLUMN_RE = /(nazwisko|imie|imię|pesel|nip|regon|email|e_mail|telefon|tel$|haslo|hasło|adres|ulica|numerdomu|nrdomu|dataur|urodzen|dowod|paszport|konto|iban|rachunek|login|pin$|skype|www|_link$|posnazwa|posadres|uwagi)/i;
export const MAX_ROWS = 150;
export const MAX_COLUMNS = 40;

/** Kolumny dopuszczone do odczytu (po filtrze PII i limicie). */
export function safeColumns(columns) {
  return columns.filter((c) => !PII_COLUMN_RE.test(c)).slice(0, MAX_COLUMNS);
}

/** Allow-lista `--only <regex>`: wyrażenie po nazwie tabeli (case-insensitive); brak wzorca = bez zawężenia. */
export function compileOnlyPattern(pattern) {
  if (pattern == null || pattern === '') return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(`--only: niepoprawne wyrażenie regularne „${pattern}": ${err.message}`);
  }
}

/** Czy tabela kwalifikuje się do zrzutu wartości. `only` (RegExp|null) tylko ZAWĘŻA — blacklista i limity obowiązują zawsze. */
export function isDictionaryTable(name, rows, only = null) {
  return DICT_TABLE_RE.test(name) && !DICT_TABLE_BLACKLIST.test(name) && Number(rows) > 0 && Number(rows) <= MAX_ROWS && (!only || only.test(name));
}

/** SELECT TOP n bezpiecznych kolumn z tabeli słownikowej (bez ORDER BY po nieznanych kolumnach). */
export function selectDictionary(db, schema, table, columns) {
  if (!isDictionaryTable(table, 1)) throw new Error(`tabela ${table} nie jest słownikiem z allowlisty`);
  const cols = safeColumns(columns);
  if (cols.length === 0) throw new Error(`tabela ${table}: brak bezpiecznych kolumn`);
  return `SELECT TOP ${MAX_ROWS} ${cols.map(quoteName).join(', ')} FROM ${quoteName(db)}.${quoteName(schema)}.${quoteName(table)}`;
}
