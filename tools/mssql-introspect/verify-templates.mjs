#!/usr/bin/env node
// Weryfikacja katalogu na produkcji: każdy szablon (albo obszar / jeden id) wykonany raz z wartościami
// `example` przez te same narzędzia co MCP. --write ustawia `verified` na dzisiejszą datę w plikach,
// które przeszły. Błąd któregokolwiek szablonu = kod wyjścia 1 (nie publikujemy dokumentów z błędem).
// Użycie: node tools/mssql-introspect/verify-templates.mjs [--area sprzedaz] [--id x] [--write] [--env plik]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sql from 'mssql';
import { configFromEnv, parseEnvFile } from './src/env.mjs';
import { createTools, DEFAULT_CATALOG_DIR } from './src/mcp-tools.mjs';
import { auditQuery } from './src/query-log.mjs';
import { loadCatalog, localDate, setVerified } from './src/templates.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const envFile = opt('--env', '/etc/kag/mssql-ilovelighting.env');
const area = opt('--area');
const onlyId = opt('--id');
const write = args.includes('--write');
const today = localDate();

const { templates, errors } = loadCatalog(DEFAULT_CATALOG_DIR);
for (const e of errors) console.log(`BŁĄD PLIKU  ${e}`);
const todo = templates.filter((t) => (!area || t.area === area) && (!onlyId || t.id === onlyId));
let pool;
const getPool = async () => (pool ??= await new sql.ConnectionPool(configFromEnv(parseEnvFile(readFileSync(envFile, 'utf8')), envFile)).connect());
const tools = createTools({ getPool, sql, audit: auditQuery });
let failed = errors.length;
try {
  for (const t of todo) {
    const example = Object.fromEntries(Object.entries(t.params).map(([n, d]) => [n, d.example]));
    try {
      const { rows, ms } = await tools.executeTemplate(t.id, example);
      console.log(`OK    ${t.id.padEnd(48)} ${String(rows.length).padStart(5)} wierszy ${String(ms).padStart(6)} ms`);
      if (write) {
        const path = join(DEFAULT_CATALOG_DIR, t.file);
        writeFileSync(path, setVerified(readFileSync(path, 'utf8'), today));
      }
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${t.id.padEnd(48)} ${err.message.split('\n')[0].slice(0, 200)}`);
    }
  }
} finally {
  await pool?.close();
}
console.log(`\nsprawdzono ${todo.length}, błędów ${failed}${write ? `, verified=${today} zapisane dla udanych` : ''}`);
process.exitCode = failed > 0 ? 1 : 0;
