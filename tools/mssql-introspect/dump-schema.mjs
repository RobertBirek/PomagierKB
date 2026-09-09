#!/usr/bin/env node
// Zrzut katalogu jednej bazy do Markdown (format wspólny z tools/kb-import) + catalog.json.
// Użycie: node tools/mssql-introspect/dump-schema.mjs <baza> --out <katalog> [--product "InsERT GT"] [--no-modules]
// Tylko metadane (sys.*): tabele, kolumny, klucze, indeksy, liczności z partycji, definicje widoków/procedur.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPool, query } from './src/connect.mjs';
import * as Q from './src/queries.mjs';
import { buildCatalog } from './src/catalog.mjs';
import { renderCatalogToFiles } from '../kb-import/lib/catalog-render.mjs';

const args = process.argv.slice(2);
const database = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const outDir = opt('--out', null);
const productLabel = opt('--product', 'InsERT GT');
const includeModules = !args.includes('--no-modules');
if (!database || !outDir) {
  console.error('użycie: dump-schema.mjs <baza> --out <katalog> [--product "..."] [--no-modules]');
  process.exit(2);
}

const { pool, target } = await openPool();
try {
  const [server] = await query(pool, Q.SERVER_INFO);
  const dbs = await query(pool, Q.LIST_DATABASES);
  if (!dbs.some((d) => d.name === database)) throw new Error(`baza ${database} nie istnieje na ${target}`);
  console.log(`zrzut katalogu ${database} z ${target}`);
  const rows = {};
  const steps = [
    ['aliasTypes', Q.dbAliasTypes],
    ['tables', Q.dbTableDescriptions],
    ['columns', Q.dbColumns],
    ['keys', Q.dbKeys],
    ['foreignKeys', Q.dbForeignKeys],
    ['indexes', Q.dbIndexes],
    ['rowCounts', Q.dbRowCounts],
    ['parameters', Q.dbParameters],
    ['modules', Q.dbModules],
  ];
  for (const [key, fn] of steps) {
    if (key === 'modules' && !includeModules) continue;
    rows[key] = await query(pool, fn(database));
    console.log(`  ${key}: ${rows[key].length} wierszy`);
  }
  const catalog = buildCatalog(
    { database, server, target: target.replace(/^[^@]+@/, ''), generatedAt: new Date().toISOString() },
    rows,
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'catalog.json'), JSON.stringify(catalog, null, 1));
  const host = catalog.meta.target;
  const entries = renderCatalogToFiles(catalog, {
    outDir,
    productLabel,
    sourceName: `żywa baza MSSQL ${database} na ${host}`,
    sourceUrlBase: `mssql://${host}/${database}`,
    date: new Date().toISOString().slice(0, 10),
    keywordsBase: [productLabel, 'baza danych', 'SQL Server', database],
    includeModules,
  });
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ source: `mssql://${host}/${database}`, entries }, null, 2));
  console.log(`tabel: ${Object.keys(catalog.tables).length}, modułów SQL: ${catalog.modules.length}, plików .md: ${entries.length}`);
} finally {
  await pool.close();
}
