#!/usr/bin/env node
// Serwer MCP (stdio) dający Claude Code na pimie TYLKO-DO-ODCZYTU dostęp do produkcyjnej bazy
// Subiekt GT ilovelighting (Magnum_Profi na 192.168.1.20\INSERTGT), osiągalnej przez WireGuard.
// Sterownik: mssql/tedious (czysty JS, ten sam co tools/mssql-introspect) — bez ODBC/uv.
// Poświadczenia z pliku 0600 (MSSQL_ENV_FILE, domyślnie /etc/kag/mssql-ilovelighting.env);
// hasło nigdy nie trafia do argv, logów ani odpowiedzi. Narzędzia: execute_sql (SELECT),
// list_templates i run_template (szablony z templates/, parametry przez request.input).
// Logika narzędzi: src/mcp-tools.mjs.
//
// Rejestracja: claude mcp add mssql -e MSSQL_ENV_FILE=/etc/kag/mssql-ilovelighting.env -s user \
//   -- node /kag/tools/mssql-introspect/mcp-server.mjs

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import sql from 'mssql';
import { parseEnvFile } from './src/env.mjs';
import { auditQuery } from './src/query-log.mjs';
import { createTools, TOOL_DEFS } from './src/mcp-tools.mjs';

const ENV_FILE = process.env.MSSQL_ENV_FILE ?? '/etc/kag/mssql-ilovelighting.env';
const log = (...a) => process.stderr.write(`[mcp-mssql] ${a.join(' ')}\n`);

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

const tools = createTools({ getPool, sql, audit: auditQuery });

// ── protokół MCP: JSON-RPC 2.0 po stdio, komunikaty rozdzielone znakiem nowej linii ──
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handle(msg) {
  const { method, params } = msg;
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mssql-ilovelighting', version: '0.2.0' },
    };
  }
  if (method === 'tools/list') return { tools: TOOL_DEFS };
  if (method === 'tools/call') {
    const args = params?.arguments ?? {};
    const run = {
      execute_sql: () => tools.executeSql(String(args.query ?? '')),
      list_templates: async () => tools.listTemplates({ area: args.area, query: args.query }),
      run_template: () => tools.runTemplate({ id: args.id, params: args.params }),
    }[params?.name];
    if (!run) throw { code: -32601, message: `nieznane narzędzie: ${params?.name}` };
    try {
      return { content: [{ type: 'text', text: await run() }] };
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
