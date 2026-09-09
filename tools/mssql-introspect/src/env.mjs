// Poświadczenia MSSQL z pliku KLUCZ=WARTOŚĆ (0600, poza repo) — konwencja /etc/kag/*.env
// (jak tools/ux-audit/lib/session.mjs). Fail-closed: brak pliku/hasła = twardy błąd.
// Hasło nigdy nie trafia do argv, logów ani wyjątków.

import { readFileSync } from 'node:fs';

export const DEFAULT_ENV_FILE = '/etc/kag/mssql-optima.env';

/** Parsuje plik KLUCZ=WARTOŚĆ (bez interpolacji, komentarze '#', cudzysłowy zdejmowane). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Konfiguracja połączenia z pliku env. Zwraca obiekt dla `mssql.connect`. */
export function loadMssqlConfig(path = process.env.MSSQL_ENV_FILE ?? DEFAULT_ENV_FILE) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`brak pliku poświadczeń MSSQL: ${path} (0600 root, klucze MSSQL_HOST/PORT/USER/PASSWORD)`);
  }
  return configFromEnv(parseEnvFile(text), path);
}

export function configFromEnv(env, source = 'env') {
  const host = env.MSSQL_HOST;
  const port = Number(env.MSSQL_PORT ?? 1433);
  const user = env.MSSQL_USER;
  const password = env.MSSQL_PASSWORD;
  if (!host || !user || !password) {
    throw new Error(`niekompletne poświadczenia MSSQL w ${source}: wymagane MSSQL_HOST, MSSQL_USER, MSSQL_PASSWORD`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MSSQL_PORT w ${source} musi być liczbą 1..65535`);
  }
  return {
    server: host,
    port,
    user,
    password,
    database: env.MSSQL_DATABASE || 'master',
    connectionTimeout: 15_000,
    requestTimeout: 60_000,
    options: {
      encrypt: true,
      trustServerCertificate: true,
      readOnlyIntent: true,
      appName: 'pomagierkb-mssql-introspect',
    },
    pool: { max: 2, min: 0 },
  };
}

/** Opis połączenia do logów — BEZ hasła. */
export function describeTarget(cfg) {
  return `${cfg.user}@${cfg.server}:${cfg.port}`;
}
