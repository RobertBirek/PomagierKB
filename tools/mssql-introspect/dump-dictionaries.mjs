#!/usr/bin/env node
// Zrzut WARTOŚCI małych tabel słownikowych `sl_*` (kody, typy, stawki) — jedyne czytanie wierszy w tym
// narzędziu; bramki w src/queries-data.mjs. Wynik: <out>/dictionaries.json (tabela → kolumny, wiersze)
// + CHECK constraints z katalogu. Render do Markdown robi tools/kb-import/prepare-dicts.mjs.
// Meta pliku NIE zawiera hosta ani użytkownika (tylko nazwa bazy) — zrzut trafia do dokumentów KB.
// Użycie: node tools/mssql-introspect/dump-dictionaries.mjs <baza> --out <katalog> [--only <regex>]
//   --only <regex>  allow-lista po nazwie tabeli (case-insensitive); blacklista i limity obowiązują nadal
//   MSSQL_ENV_FILE  plik poświadczeń (domyślnie /etc/kag/mssql-optima.env)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPool, query } from './src/connect.mjs';
import { dbRowCounts, quoteName } from './src/queries.mjs';
import { PII_COLUMN_RE, compileOnlyPattern, isDictionaryTable, safeColumns, selectDictionary } from './src/queries-data.mjs';

const USAGE = 'użycie: dump-dictionaries.mjs <baza> --out <katalog> [--only <regex>]';
const OPTIONS = new Set(['--out', '--only']);
const opts = {};
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (OPTIONS.has(args[i])) {
    opts[args[i]] = args[i + 1];
    i += 1;
  } else {
    positional.push(args[i]);
  }
}
const [database] = positional;
const outDir = opts['--out'];
if (!database || !outDir || positional.length > 1 || ('--only' in opts && !opts['--only'])) {
  console.error(USAGE);
  process.exit(2);
}
let only;
try {
  only = compileOnlyPattern(opts['--only']);
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}

const { pool, target } = await openPool();
try {
  const q = quoteName(database);
  const counts = await query(pool, dbRowCounts(database));
  const candidates = counts.filter((r) => r.schemaName === 'dbo' && isDictionaryTable(r.tableName, r.rowsCount, only));
  console.log(`baza ${database} (${target})${only ? `, allow-lista --only ${only}` : ''}: tabel sl_* z wartościami w limicie: ${candidates.length}`);
  const columnsByTable = new Map();
  for (const c of await query(
    pool,
    `SELECT t.name AS tableName, c.name AS columnName, ty.name AS typeName FROM ${q}.sys.columns c JOIN ${q}.sys.tables t ON t.object_id = c.object_id JOIN ${q}.sys.types ty ON ty.user_type_id = c.user_type_id WHERE t.name LIKE 'sl[_]%' ORDER BY t.name, c.column_id`,
  )) {
    if (!columnsByTable.has(c.tableName)) columnsByTable.set(c.tableName, []);
    columnsByTable.get(c.tableName).push({ name: c.columnName, type: c.typeName });
  }
  const checks = await query(
    pool,
    `SELECT t.name AS tableName, cc.name AS constraintName, cc.definition FROM ${q}.sys.check_constraints cc JOIN ${q}.sys.tables t ON t.object_id = cc.parent_object_id ORDER BY t.name, cc.name`,
  );
  const dictionaries = [];
  let skippedPii = 0;
  for (const t of candidates) {
    const cols = columnsByTable.get(t.tableName) ?? [];
    // Pomijamy kolumny binarne/duże i osobowe; tabela bez bezpiecznych kolumn poza Id jest pomijana.
    const readable = cols.filter((c) => !/^(image|varbinary|binary|xml|geography|geometry|hierarchyid)$/i.test(c.type)).map((c) => c.name);
    const safe = safeColumns(readable);
    skippedPii += readable.length - safe.length;
    if (safe.filter((c) => !/id$/i.test(c)).length === 0) continue;
    const rows = await query(pool, selectDictionary(database, 'dbo', t.tableName, readable));
    dictionaries.push({ table: t.tableName, rows: Number(t.rowsCount), columns: safe, values: rows.map((r) => Object.fromEntries(safe.map((c) => [c, r[c] instanceof Date ? r[c].toISOString().slice(0, 10) : r[c]]))) });
  }
  mkdirSync(outDir, { recursive: true });
  // Meta bez hosta/użytkownika: identyfikacja źródła wyłącznie nazwą bazy (plik ląduje w dokumentach KB).
  writeFileSync(
    join(outDir, 'dictionaries.json'),
    JSON.stringify({ database, only: only ? only.source : null, generatedAt: new Date().toISOString(), piiColumnRule: String(PII_COLUMN_RE), dictionaries, checks }, null, 1),
  );
  console.log(`słowników: ${dictionaries.length}, wierszy: ${dictionaries.reduce((a, d) => a + d.values.length, 0)}, kolumn pominiętych (PII): ${skippedPii}, CHECK constraints: ${checks.length}`);
} finally {
  await pool.close();
}
