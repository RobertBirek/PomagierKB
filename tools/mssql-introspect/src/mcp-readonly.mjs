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
  return { ok: true };
}
