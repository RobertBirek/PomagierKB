#!/usr/bin/env node
// Runner hostowy: JEDNO zapytanie SELECT przez tę samą bramkę tylko-do-odczytu i z tym samym logiem
// zapytań co serwer MCP (src/mcp-readonly.mjs, /srv/kag-data/kag/mcp-mssql/queries.jsonl). Dla
// narzędzi i agentów testujących szablony KPI na produkcyjnej bazie BEZ przechodzenia przez proces
// MCP sesji (który po zmianie bramki ładuje nowy kod dopiero przy restarcie sesji).
// Użycie: node tools/mssql-introspect/run-select.mjs [--env /etc/kag/mssql-ilovelighting.env] [--max-rows 50] "SELECT …"
//   albo zapytanie na stdin. Wynik: JSON {rows, count, ms} na stdout; odrzucenie = kod wyjścia 2.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sql from 'mssql';
import { configFromEnv, describeTarget, parseEnvFile } from './src/env.mjs';
import { checkReadOnly } from './src/mcp-readonly.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const envFile = opt('--env', '/etc/kag/mssql-ilovelighting.env');
const maxRows = Number(opt('--max-rows', '200'));
const positional = args.filter((a, i) => !a.startsWith('--') && !['--env', '--max-rows'].includes(args[i - 1]));
const query = (positional.join(' ') || readFileSync(0, 'utf8')).trim();
const QUERY_LOG = process.env.MSSQL_MCP_QUERY_LOG ?? '/srv/kag-data/kag/mcp-mssql/queries.jsonl';
const audit = (entry) => {
  try {
    mkdirSync(dirname(QUERY_LOG), { recursive: true, mode: 0o700 });
    appendFileSync(QUERY_LOG, `${JSON.stringify({ ts: new Date().toISOString(), via: 'run-select', ...entry })}\n`, { mode: 0o600 });
  } catch { /* log jest best-effort */ }
};

const gate = checkReadOnly(query);
if (!gate.ok) {
  audit({ ok: false, reason: gate.reason, query: query.slice(0, 4000) });
  console.error(`odrzucone (tryb tylko-do-odczytu): ${gate.reason}`);
  process.exit(2);
}
const cfg = configFromEnv(parseEnvFile(readFileSync(envFile, 'utf8')), envFile);
const started = Date.now();
let pool;
try {
  pool = await new sql.ConnectionPool(cfg).connect();
  const res = await pool.request().query(query);
  const rows = (res.recordset ?? []).slice(0, maxRows);
  audit({ ok: true, rows: rows.length, ms: Date.now() - started, query: query.slice(0, 4000) });
  console.log(JSON.stringify({ target: describeTarget(cfg), count: res.recordset?.length ?? 0, ms: Date.now() - started, rows }, null, 1));
} catch (err) {
  audit({ ok: false, reason: `błąd wykonania: ${String(err.message).slice(0, 300)}`, query: query.slice(0, 4000) });
  console.error(`błąd: ${err.message}`);
  process.exit(1);
} finally {
  await pool?.close();
}
