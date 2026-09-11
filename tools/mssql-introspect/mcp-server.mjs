#!/usr/bin/env node
// Serwer MCP (stdio) dający Claude Code na pimie TYLKO-DO-ODCZYTU dostęp do produkcyjnej bazy
// Subiekt GT ilovelighting (Magnum_Profi na 192.168.1.20\INSERTGT), osiągalnej przez WireGuard.
// Sterownik: mssql/tedious (czysty JS, ten sam co tools/mssql-introspect) — bez ODBC/uv.
// Poświadczenia z pliku 0600 (MSSQL_ENV_FILE, domyślnie /etc/kag/mssql-ilovelighting.env);
// hasło nigdy nie trafia do argv, logów ani odpowiedzi. Jedyne narzędzie: execute_sql (SELECT).
//
// Rejestracja: claude mcp add mssql -e MSSQL_ENV_FILE=/etc/kag/mssql-ilovelighting.env -s user \
//   -- node /kag/tools/mssql-introspect/mcp-server.mjs

import { createInterface } from 'node:readline';
import sql from 'mssql';
import { parseEnvFile } from './src/env.mjs';
import { checkReadOnly } from './src/mcp-readonly.mjs';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ENV_FILE = process.env.MSSQL_ENV_FILE ?? '/etc/kag/mssql-ilovelighting.env';
// Log TREŚCI każdego zapytania (przyjęte i odrzucone) — ślad rozliczalności dla governance §1.3;
// plik 0600 na hoście, poza repo. Bez wyników (te mogą nieść dane).
const QUERY_LOG = process.env.MSSQL_MCP_QUERY_LOG ?? '/srv/kag-data/kag/mcp-mssql/queries.jsonl';
const MAX_ROWS = 200;
const MAX_CHARS = 60_000;
const log = (...a) => process.stderr.write(`[mcp-mssql] ${a.join(' ')}\n`);

function auditQuery(entry) {
  try {
    mkdirSync(dirname(QUERY_LOG), { recursive: true, mode: 0o700 });
    appendFileSync(QUERY_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch (err) {
    log(`log zapytań niedostępny: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Konfiguracja mssql z pliku env; host „adres\\instancja" → server + options.instanceName. */
function loadConfig() {
  const env = parseEnvFile(readFileSync(ENV_FILE, 'utf8'));
  const host = env.MSSQL_HOST;
  const user = env.MSSQL_USER;
  const password = env.MSSQL_PASSWORD;
  if (!host || !user || !password) throw new Error(`niekompletne poświadczenia w ${ENV_FILE} (MSSQL_HOST/USER/PASSWORD)`);
  const [server, instanceName] = host.split('\\');
  const options = {
    encrypt: env.MSSQL_ENCRYPT !== 'false',
    trustServerCertificate: (env.TrustServerCertificate ?? 'yes').toLowerCase() !== 'no',
    readOnlyIntent: true,
    appName: 'pomagierkb-mssql-readonly',
  };
  if (instanceName) options.instanceName = instanceName;
  const cfg = {
    server,
    user,
    password,
    database: env.MSSQL_DATABASE || 'master',
    connectionTimeout: 15_000,
    requestTimeout: 60_000,
    options,
    pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
  };
  if (!instanceName && env.MSSQL_PORT) cfg.port = Number(env.MSSQL_PORT);
  return { cfg, label: `${user}@${host}/${cfg.database}` };
}

let poolPromise = null;
function getPool() {
  if (poolPromise === null) {
    const { cfg, label } = loadConfig();
    log(`łączę: ${label}`);
    poolPromise = new sql.ConnectionPool(cfg).connect().catch((err) => {
      poolPromise = null; // pozwól spróbować ponownie przy następnym wywołaniu
      throw new Error(`połączenie nieudane: ${err.message}`);
    });
  }
  return poolPromise;
}

async function runQuery(text) {
  const gate = checkReadOnly(text);
  const query = text.slice(0, 4000);
  if (!gate.ok) {
    auditQuery({ ok: false, reason: gate.reason, query });
    throw new Error(`odrzucone (tryb tylko-do-odczytu): ${gate.reason}`);
  }
  const started = Date.now();
  let res;
  try {
    const pool = await getPool();
    res = await pool.request().query(text);
  } catch (err) {
    auditQuery({ ok: false, reason: `błąd wykonania: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`, query });
    throw err;
  }
  const rows = res.recordset ?? [];
  auditQuery({ ok: true, rows: rows.length, ms: Date.now() - started, query });
  const capped = rows.slice(0, MAX_ROWS);
  let body = JSON.stringify(capped, null, 1);
  let note = `${rows.length} wierszy`;
  if (rows.length > MAX_ROWS) note += `, pokazano pierwsze ${MAX_ROWS}`;
  if (body.length > MAX_CHARS) {
    body = body.slice(0, MAX_CHARS);
    note += `, wynik przycięty do ${MAX_CHARS} znaków`;
  }
  return `${note}\n${body}`;
}

// ── protokół MCP: JSON-RPC 2.0 po stdio, komunikaty rozdzielone znakiem nowej linii ──
const TOOLS = [
  {
    name: 'execute_sql',
    description:
      'Wykonuje JEDNO zapytanie SELECT (tylko odczyt) na produkcyjnej bazie Subiekt GT ilovelighting ' +
      '(Magnum_Profi). Zapis, DDL, procedury i wiele zapytań są odrzucane. Zwraca wiersze jako JSON ' +
      `(do ${MAX_ROWS} wierszy).`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string', description: 'Zapytanie SELECT (jedno, bez ";")' } },
    },
  },
];

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handle(msg) {
  const { method, params } = msg;
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mssql-ilovelighting', version: '0.1.0' },
    };
  }
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    if (params?.name !== 'execute_sql') throw { code: -32601, message: `nieznane narzędzie: ${params?.name}` };
    try {
      const text = await runQuery(String(params?.arguments?.query ?? ''));
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }
  if (method === 'ping') return {};
  throw { code: -32601, message: `nieznana metoda: ${method}` };
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // nie-JSON ignorujemy
  }
  if (msg.method && msg.id === undefined) return; // notyfikacja (np. notifications/initialized) — bez odpowiedzi
  Promise.resolve()
    .then(() => handle(msg))
    .then((result) => send({ jsonrpc: '2.0', id: msg.id, result }))
    .catch((err) => {
      const e = err && typeof err === 'object' && 'code' in err ? err : { code: -32603, message: err instanceof Error ? err.message : String(err) };
      send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code, message: e.message } });
    });
});
rl.on('close', () => {
  if (poolPromise) poolPromise.then((p) => p.close()).catch(() => {});
  process.exit(0);
});
log(`gotowy, env=${ENV_FILE}`);
