#!/usr/bin/env node
// Zrzut WARTOŚCI małych tabel słownikowych `sl_*` (kody, typy, stawki) — jedyne czytanie wierszy w tym
// narzędziu; bramki w src/queries-data.mjs. Wynik: <out>/dictionaries.json (tabela → kolumny, wiersze)
// + CHECK constraints z katalogu. Render do Markdown robi tools/kb-import/prepare-dicts.mjs.
// Użycie: node tools/mssql-introspect/dump-dictionaries.mjs <baza> --out <katalog>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPool, query } from './src/connect.mjs';
import { dbRowCounts, quoteName } from './src/queries.mjs';
import { PII_COLUMN_RE, isDictionaryTable, safeColumns, selectDictionary } from './src/queries-data.mjs';

const args = process.argv.slice(2);
const database = args.find((a) => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
if (!database || !outDir) {
  console.error('użycie: dump-dictionaries.mjs <baza> --out <katalog>');
  process.exit(2);
}

const { pool, target } = await openPool();
try {
  const q = quoteName(database);
  const counts = await query(pool, dbRowCounts(database));
  const candidates = counts.filter((r) => r.schemaName === 'dbo' && isDictionaryTable(r.tableName, r.rowsCount));
  console.log(`baza ${database} (${target}): tabel sl_* z wartościami w limicie: ${candidates.length}`);
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
  writeFileSync(join(outDir, 'dictionaries.json'), JSON.stringify({ database, target: target.replace(/^[^@]+@/, ''), generatedAt: new Date().toISOString(), piiColumnRule: String(PII_COLUMN_RE), dictionaries, checks }, null, 1));
  console.log(`słowników: ${dictionaries.length}, wierszy: ${dictionaries.reduce((a, d) => a + d.values.length, 0)}, kolumn pominiętych (PII): ${skippedPii}, CHECK constraints: ${checks.length}`);
} finally {
  await pool.close();
}
