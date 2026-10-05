#!/usr/bin/env node
// Runner hostowy: JEDEN szablon z katalogu templates/ przez te same narzędzia co serwer MCP
// (src/mcp-tools.mjs: walidacja parametrów, bramka, request.input, log via=template). Dla sesji,
// w których proces MCP ma jeszcze stary kod (nowe narzędzia ładują się dopiero po restarcie).
// Użycie: node tools/mssql-introspect/run-template.mjs <id> [nazwa=wartość ...] [--env plik] [--max-rows 50]
// Wynik: JSON {template, verified, count, ms, rows} na stdout; błąd walidacji/bramki = kod 2.

import { readFileSync } from 'node:fs';
import sql from 'mssql';
import { configFromEnv, parseEnvFile } from './src/env.mjs';
import { createTools } from './src/mcp-tools.mjs';
import { auditQuery } from './src/query-log.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const envFile = opt('--env', '/etc/kag/mssql-ilovelighting.env');
const maxRows = Number(opt('--max-rows', '200'));
const KNOWN = new Set(['--env', '--max-rows']);
const positional = args.filter((a, i) => !KNOWN.has(a) && !KNOWN.has(args[i - 1] ?? ''));
const [id, ...pairs] = positional;
if (!id) {
  console.error('użycie: run-template.mjs <id> [nazwa=wartość ...] [--env plik] [--max-rows N]');
  process.exit(2);
}
const params = Object.fromEntries(pairs.map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));

let pool;
const getPool = async () => (pool ??= await new sql.ConnectionPool(configFromEnv(parseEnvFile(readFileSync(envFile, 'utf8')), envFile)).connect());
const tools = createTools({ getPool, sql, audit: auditQuery });
try {
  const { template, rows, ms } = await tools.executeTemplate(id, params);
  console.log(JSON.stringify({ template: template.id, verified: template.verified, count: rows.length, ms, rows: rows.slice(0, maxRows) }, null, 1));
} catch (err) {
  console.error(`błąd: ${err.message}`);
  process.exitCode = /^(parametry|nieznany szablon|szablon .* jest błędny|odrzucone)/.test(err.message) ? 2 : 1;
} finally {
  await pool?.close();
}
