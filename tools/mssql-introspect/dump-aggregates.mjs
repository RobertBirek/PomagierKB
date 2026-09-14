#!/usr/bin/env node
// Zrzut AGREGATÓW z produkcyjnej bazy Subiekt GT (instancja produkcyjna Magnum_Profi) do JSON.
// Zapytania są stałymi w src/queries-aggregates.mjs (test wymusza: checkReadOnly, tylko agregaty, zero
// kolumn osobowych). Liczniki kontrahentów (kind 'people') poniżej progu k są zastępowane "<k".
// Połączenie jak run-select.mjs (configFromEnv + mssql, readOnlyIntent); każde zapytanie trafia do
// wspólnego logu zapytań (src/query-log.mjs). Wynik: <out>/aggregates.json — meta BEZ hosta.
// Użycie: node tools/mssql-introspect/dump-aggregates.mjs --out <katalog> [--k 10] [--env <plik>]
//   plik poświadczeń: --env, inaczej $MSSQL_ENV_FILE, inaczej /etc/kag/mssql-ilovelighting.env
// Kody wyjścia: 2 = błąd użycia / agregat odrzucony przez bramkę, 1 = błąd połączenia.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sql from 'mssql';
import { loadMssqlConfig } from './src/env.mjs';
import { checkReadOnly } from './src/mcp-readonly.mjs';
import {
  AGGREGATES, CONTRACTOR_KINDS, DOC_TYPES, K_DEFAULT, MAX_ROWS, PRODUCT_KINDS, PURCHASE_DOC_TYPES, SALES_DOC_TYPES,
  applyKAnonymity, plainRows,
} from './src/queries-aggregates.mjs';
import { auditQuery } from './src/query-log.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const outDir = opt('--out', null);
const k = Number(opt('--k', String(K_DEFAULT)));
const envFile = opt('--env', process.env.MSSQL_ENV_FILE ?? '/etc/kag/mssql-ilovelighting.env');
if (!outDir || !Number.isInteger(k) || k < 1) {
  console.error('użycie: dump-aggregates.mjs --out <katalog> [--k 10] [--env <plik poświadczeń>]');
  process.exit(2);
}

// Bramka PRZED połączeniem — fail-closed: jeden odrzucony agregat = brak zrzutu.
for (const a of AGGREGATES) {
  const gate = checkReadOnly(a.sql);
  if (!gate.ok) {
    auditQuery('dump-aggregates', { ok: false, id: a.id, reason: gate.reason, query: a.sql });
    console.error(`agregat ${a.id} odrzucony przez bramkę tylko-do-odczytu: ${gate.reason}`);
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
/** Komunikaty błędów sterownika mogą nieść adres hosta — do JSON/stdout idą bez niego. */
const scrub = (msg) => {
  let s = String(msg ?? '');
  for (const secret of [cfg.server, cfg.options?.instanceName, cfg.user].filter(Boolean)) s = s.replaceAll(secret, '<redacted>');
  return s;
};

const results = [];
let pool;
try {
  pool = await new sql.ConnectionPool(cfg).connect();
} catch (err) {
  console.error(`połączenie z MSSQL nieudane: ${scrub(err.message)}`);
  process.exit(1);
}
try {
  for (const a of AGGREGATES) {
    const started = Date.now();
    const entry = { id: a.id, title: a.title, kind: a.kind, shape: a.shape, rows: [] };
    try {
      const res = await pool.request().query(a.sql);
      const raw = res.recordset ?? [];
      auditQuery('dump-aggregates', { ok: true, id: a.id, rows: raw.length, ms: Date.now() - started, query: a.sql });
      entry.rows = applyKAnonymity(a, plainRows(raw.slice(0, MAX_ROWS)), k);
      if (a.shape === 'single' && raw.length !== 1) entry.note = `oczekiwano 1 wiersza, jest ${raw.length}`;
      if (raw.length > MAX_ROWS) entry.note = `wynik przycięty do ${MAX_ROWS} z ${raw.length} wierszy`;
    } catch (err) {
      const reason = scrub(err.message).slice(0, 300);
      auditQuery('dump-aggregates', { ok: false, id: a.id, reason: `błąd wykonania: ${reason}`, query: a.sql });
      entry.error = reason;
      console.error(`agregat ${a.id}: błąd wykonania: ${reason}`);
    }
    results.push(entry);
  }
} finally {
  await pool.close();
}

mkdirSync(outDir, { recursive: true });
const out = {
  meta: {
    database: cfg.database,
    generatedAt: new Date().toISOString(),
    k,
    kRule: `kind 'people': liczniki kontrahentów (kColumns) < k zastąpione "<k"`,
    tool: 'tools/mssql-introspect/dump-aggregates.mjs',
    labels: { docTypes: DOC_TYPES, salesDocTypes: SALES_DOC_TYPES, purchaseDocTypes: PURCHASE_DOC_TYPES, productKinds: PRODUCT_KINDS, contractorKinds: CONTRACTOR_KINDS },
  },
  results,
};
writeFileSync(join(outDir, 'aggregates.json'), JSON.stringify(out, null, 1));
const failed = results.filter((r) => r.error).length;
console.log(`baza ${cfg.database}: agregatów ${results.length}, z błędem ${failed}, wierszy ${results.reduce((s, r) => s + r.rows.length, 0)}, k=${k} → ${join(outDir, 'aggregates.json')}`);
if (failed > 0) process.exit(1);
