// Bramka TYLKO-DO-ODCZYTU dla serwera MCP mssql (baza produkcyjna Subiekt GT ilovelighting).
// Czysta logika, testowana. Zasada fail-closed: cokolwiek nie jest jednoznacznie pojedynczym
// zapytaniem czytającym (SELECT / WITH…SELECT) → odrzucone. Zabezpiecza konto, które w bazie
// MOŻE mieć prawa zapisu — obroną jest ta funkcja, nie uprawnienia loginu.

const FORBIDDEN = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
  'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY', 'BACKUP', 'RESTORE', 'INTO',
  'SHUTDOWN', 'RECONFIGURE', 'DBCC', 'UPDATETEXT', 'WRITETEXT', 'BULK', 'OPENQUERY',
  'OPENROWSET', 'SP_', 'XP_', 'WAITFOR',
];

// ── Dane osobowe (decyzja właściciela 2026-09-11, docs/data-governance.md §1.3) ───────────
// Login w bazie produkcyjnej ma db_datareader, więc obroną jest ta lista, nie uprawnienia.
// Kolumny osobowe wyprowadzone z realnego katalogu (kh__Kontrahent, adr__Ewid, pr_Pracownik,
// pd_Uzytkownik, ewidencje księgowe z kopią nazwy/NIP kontrahenta). Sprawdzane na KAŻDYM
// identyfikatorze zapytania (projekcja, WHERE, ORDER BY — kolejność po nazwisku też ujawnia).
// Nazwy TOWARÓW i słowników (tw_Nazwa, grt_Nazwa, sl_*) są dozwolone — to nie są dane osób.
const PII_IDENT_PATTERNS = [
  /(nazwisko|imie|pesel|regon|e_?mail|telefon|fax|ulica|miejscowosc|kodpoczt|dowod|paszport|iban|rachunek|haslo|login|uwagi|skype|www|urodz|kontakt)/,
  /nip(?![a-z])/, // kh_NIP, adr_NIP, ev_NIPKh, khp_KontrolaNIP — 'nip' jako segment, nie fragment innego słowa
  /adres(?!\w*id$)/, // adr_Adres, kh_AdresDostawy (tekst) — ale dok_AdresDostawyId (klucz) przechodzi
  /^(kh|adr|adrh|pk|pr|pro|pw|uz|ev|oe|zpk|kpr|prz|ppr|ewa|oss)_(kh)?nazwa(pelna)?(kh)?$/, // nazwy kontrahentów/osób/ewidencji
  /^kh_symbol$/, // symbol kontrahenta = w B2C zwykle nazwisko
  /(nazwakh|nazwapelnakh|khnazwa|khnazwapelna|ulicakh|kodpocztowykh)$/,
];
/** Tabele, na których `*` / `alias.*` ujawniłoby kolumny osobowe. */
const PII_TABLE_RE = /^(kh__kontrahent|kh_pracownik|kh_kontakt\w*|adr__ewid|adr_historia|pr_\w+|pd_uzytkownik|pd_wspolnik|pd__podmiot|ewa__ewidencjeakcyzowe|kpr__ksiega|oss__ewid|prz__przychod|vat__ewidvat|zpk__ksiega|poj_eksploatacja|kom_parametr)$/;

function isPiiIdentifier(ident) {
  const id = ident.toLowerCase();
  return PII_IDENT_PATTERNS.some((re) => re.test(id));
}

/** Usuwa komentarze, literały tekstowe i identyfikatory w cudzysłowach/nawiasach, by słowa
 *  kluczowe wewnątrz danych nie myliły detekcji (i odwrotnie). */
function stripNoise(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // /* ... */
    .replace(/--[^\n]*/g, ' ') // -- ...
    .replace(/N?'(?:''|[^'])*'/g, "''") // 'literały' i N'literały'
    .replace(/"(?:""|[^"])*"/g, '""') // "identyfikatory"
    .replace(/\[(?:\]\]|[^\]])*\]/g, '[]'); // [identyfikatory]
}

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 * Dozwolone: pojedyncze zapytanie zaczynające się od SELECT albo WITH (CTE → SELECT),
 * bez żadnego słowa mutującego i bez SELECT … INTO.
 */
export function checkReadOnly(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') return { ok: false, reason: 'puste zapytanie' };
  const cleaned = stripNoise(sql).trim().replace(/;+\s*$/, ''); // jeden opcjonalny średnik na końcu
  if (cleaned === '') return { ok: false, reason: 'puste zapytanie po usunięciu komentarzy' };
  if (cleaned.includes(';')) return { ok: false, reason: 'dozwolone jest tylko jedno zapytanie (bez ";")' };
  const upper = cleaned.toUpperCase();
  const first = upper.match(/^[A-Z]+/)?.[0] ?? '';
  if (first !== 'SELECT' && first !== 'WITH') {
    return { ok: false, reason: `zapytanie musi zaczynać się od SELECT lub WITH (jest: ${first || '?'})` };
  }
  for (const kw of FORBIDDEN) {
    const re = kw.endsWith('_') ? new RegExp(`\\b${kw}`, 'i') : new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(upper)) return { ok: false, reason: `słowo zabronione w trybie odczytu: ${kw.replace(/_$/, '_*')}` };
  }
  // Dane osobowe: każdy identyfikator (także za aliasem: k.kh_Nazwa → kh_Nazwa)
  const idents = cleaned.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const pii = idents.find((id) => isPiiIdentifier(id));
  if (pii !== undefined) return { ok: false, reason: `kolumna z danymi osobowymi poza zakresem odczytu: ${pii}` };
  // `*` na tabeli z danymi osobowymi (COUNT(*) nie jest projekcją)
  const tables = idents.filter((id) => PII_TABLE_RE.test(id.toLowerCase()));
  if (tables.length > 0) {
    const withoutCount = cleaned.replace(/count\s*\(\s*\*\s*\)/gi, 'COUNT(1)');
    if (/(^|[\s,(])\*|\.\*/.test(withoutCount)) {
      return { ok: false, reason: `SELECT * na tabeli z danymi osobowymi (${tables[0]}) — wskaż kolumny bez danych osobowych` };
    }
  }
  return { ok: true };
}
