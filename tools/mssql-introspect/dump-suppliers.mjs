#!/usr/bin/env node
// Lista DOSTAWCÓW-OSÓB PRAWNYCH z produkcyjnej bazy Subiekt GT (instancja produkcyjna Magnum_Profi).
//
// TO JEST JEDYNE SANKCJONOWANE MIEJSCE, KTÓRE CZYTA KOLUMNĘ NAZWY KONTRAHENTA
// (adr__Ewid.adr_NazwaPelna / adr_Nazwa dla adresu siedziby; kh__Kontrahent nie ma kolumny nazwy).
// Podstawa: docs/data-governance.md §1.2 — decyzja IloveKB 2026-09-11: nazwy dostawców będących
// osobami prawnymi nie są danymi osobowymi; nazwy jednoosobowych działalności (osoby fizyczne) SĄ
// i są odrzucane w kodzie (src/queries-suppliers.mjs: kh_Osoba = 0 + wzorzec formy prawnej), a
// odrzucone nazwy nie trafiają ani do pliku, ani na stdout, ani do logu zapytań (log = treść SQL).
// Zapytanie z nazwą jest sprawdzane bramką checkReadOnly z zamaskowaną kolumną nazwy — każde inne
// pole osobowe i DML nadal są blokowane. Pozostałe zapytania przechodzą checkReadOnly wprost.
// Wynik: <out>/suppliers.json {meta:{database, generatedAt, rule, stats}, suppliers:[{name, productCount, brands}]}
// — meta BEZ hosta. Użycie: node tools/mssql-introspect/dump-suppliers.mjs --out <katalog> [--env <plik>]
//   plik poświadczeń: --env, inaczej $MSSQL_ENV_FILE, inaczej /etc/kag/mssql-ilovelighting.env

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sql from 'mssql';
import { loadMssqlConfig } from './src/env.mjs';
import { checkReadOnly } from './src/mcp-readonly.mjs';
import {
  LEGAL_FORM_RULE, NAMES_QUERY_MASKED_IDENTIFIERS, SANCTIONED_NAME_COLUMNS, SUPPLIER_QUERIES, buildSupplierList, checkReadOnlyExcept,
} from './src/queries-suppliers.mjs';
import { auditQuery } from './src/query-log.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const outDir = opt('--out', null);
const envFile = opt('--env', process.env.MSSQL_ENV_FILE ?? '/etc/kag/mssql-ilovelighting.env');
if (!outDir) {
  console.error('użycie: dump-suppliers.mjs --out <katalog> [--env <plik poświadczeń>]');
  process.exit(2);
}

// Bramki PRZED połączeniem (fail-closed).
const gates = [
  ['counts', checkReadOnly(SUPPLIER_QUERIES.counts)],
  ['brands', checkReadOnly(SUPPLIER_QUERIES.brands)],
  ['names', checkReadOnlyExcept(SUPPLIER_QUERIES.names, NAMES_QUERY_MASKED_IDENTIFIERS)],
];
for (const [name, gate] of gates) {
  if (!gate.ok) {
    auditQuery('dump-suppliers', { ok: false, id: name, reason: gate.reason, query: SUPPLIER_QUERIES[name] });
    console.error(`zapytanie ${name} odrzucone przez bramkę tylko-do-odczytu: ${gate.reason}`);
    process.exit(2);
  }
}

let cfg;
try {
  cfg = loadMssqlConfig(envFile);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const scrub = (msg) => {
  let s = String(msg ?? '');
  for (const secret of [cfg.server, cfg.options?.instanceName, cfg.user].filter(Boolean)) s = s.replaceAll(secret, '<redacted>');
  return s;
};

async function run(pool, id, text, extra = {}) {
  const started = Date.now();
  try {
    const res = await pool.request().query(text);
    const rows = res.recordset ?? [];
    auditQuery('dump-suppliers', { ok: true, id, rows: rows.length, ms: Date.now() - started, query: text, ...extra });
    return rows;
  } catch (err) {
    auditQuery('dump-suppliers', { ok: false, id, reason: `błąd wykonania: ${scrub(err.message).slice(0, 300)}`, query: text, ...extra });
    throw err;
  }
}

let pool;
try {
  pool = await new sql.ConnectionPool(cfg).connect();
} catch (err) {
  console.error(`połączenie z MSSQL nieudane: ${scrub(err.message)}`);
  process.exit(1);
}
let result;
try {
  const counts = await run(pool, 'counts', SUPPLIER_QUERIES.counts);
  const brands = await run(pool, 'brands', SUPPLIER_QUERIES.brands);
  // Jedyne czytanie nazwy kontrahenta — oznaczone w logu zapytań.
  const names = await run(pool, 'names', SUPPLIER_QUERIES.names, { sanctioned: 'contractor-name (data-governance §1.2, 2026-09-11)' });
  result = buildSupplierList({ counts, brands, names });
} catch (err) {
  console.error(`błąd: ${scrub(err.message)}`);
  process.exit(1);
} finally {
  await pool.close();
}

mkdirSync(outDir, { recursive: true });
const out = {
  meta: {
    database: cfg.database,
    generatedAt: new Date().toISOString(),
    rule: LEGAL_FORM_RULE,
    sanctionedColumns: SANCTIONED_NAME_COLUMNS,
    stats: result.stats,
    tool: 'tools/mssql-introspect/dump-suppliers.mjs',
  },
  suppliers: result.suppliers,
};
writeFileSync(join(outDir, 'suppliers.json'), JSON.stringify(out, null, 1));
// Na stdout wyłącznie liczności — nigdy nazwy.
const { candidates, kept, droppedNaturalPersons, unnamed } = result.stats;
console.log(`baza ${cfg.database}: kandydatów ${candidates}, osób prawnych ${kept}, odrzuconych (brak formy prawnej) ${droppedNaturalPersons}, bez adresu siedziby ${unnamed} → ${join(outDir, 'suppliers.json')}`);
