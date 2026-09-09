#!/usr/bin/env node
// Lista baz na instancji + odcisk produktu (InsERT GT / nexo / Optima). Tylko katalog systemowy.
// Użycie: node tools/mssql-introspect/list-dbs.mjs [--json]
// Poświadczenia: MSSQL_ENV_FILE (domyślnie /etc/kag/mssql-optima.env). Wynik NIE trafia do KB.

import { openPool, query } from './src/connect.mjs';
import { LIST_DATABASES, SERVER_INFO, dbObjectCounts, dbTablesSummary } from './src/queries.mjs';
import { PRODUCT_LABELS, fingerprint } from './src/fingerprint.mjs';

const SYSTEM_DBS = new Set(['master', 'model', 'msdb', 'tempdb']);
const asJson = process.argv.includes('--json');

const { pool, target } = await openPool();
try {
  const [info] = await query(pool, SERVER_INFO);
  const dbs = await query(pool, LIST_DATABASES);
  const rows = [];
  for (const db of dbs) {
    const row = { ...db, system: SYSTEM_DBS.has(db.name), tables: null, objects: {}, product: 'unknown', matched: [] };
    if (db.state === 'ONLINE' && !row.system) {
      try {
        const tables = await query(pool, dbTablesSummary(db.name));
        row.tables = tables.length;
        const fp = fingerprint(tables.map((t) => t.tableName));
        row.product = fp.product;
        row.matched = fp.matched;
        for (const oc of await query(pool, dbObjectCounts(db.name))) row.objects[oc.typeDesc] = oc.cnt;
      } catch (err) {
        row.error = err.message.replace(/password[^,;]*/gi, '<redacted>');
      }
    }
    rows.push(row);
  }

  if (asJson) {
    console.log(JSON.stringify({ target, server: info, databases: rows }, null, 2));
  } else {
    console.log(`Serwer: ${target}`);
    console.log(`${String(info.version).split('\n')[0]} | edycja: ${info.edition} | instancja: ${info.instanceName ?? '(domyślna)'} | collation: ${info.collation}`);
    console.log('');
    const pad = (s, n) => String(s ?? '').padEnd(n);
    console.log(pad('baza', 28) + pad('stan', 8) + pad('compat', 7) + pad('dane MB', 10) + pad('log MB', 9) + pad('tabel', 7) + pad('produkt', 44) + 'odcisk');
    for (const r of rows) {
      console.log(
        pad(r.name, 28) + pad(r.state, 8) + pad(r.compat, 7) + pad(r.dataMb, 10) + pad(r.logMb, 9) +
        pad(r.system ? 'sys' : r.tables ?? '?', 7) + pad(r.system ? '(systemowa)' : PRODUCT_LABELS[r.product], 44) +
        (r.matched.length ? r.matched.join(',') : r.error ? `BŁĄD: ${r.error}` : ''),
      );
    }
  }
} finally {
  await pool.close();
}
