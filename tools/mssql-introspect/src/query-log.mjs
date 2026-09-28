// Wspólny log TREŚCI zapytań do bazy produkcyjnej Subiekt GT — ten sam plik, do którego piszą
// mcp-server.mjs i run-select.mjs (/srv/kag-data/kag/mcp-mssql/queries.jsonl, 0600). Ślad
// rozliczalności wg docs/data-governance.md §1.3: każde zapytanie (przyjęte i odrzucone), bez wyników.
// Best-effort: brak dostępu do pliku nie przerywa narzędzia, ale raz na plik ostrzega na stderr
// (bez treści zapytania i parametrów) — cicha utrata śladu rozliczalności byłaby niewidoczna.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const QUERY_LOG = process.env.MSSQL_MCP_QUERY_LOG ?? '/srv/kag-data/kag/mcp-mssql/queries.jsonl';
const warned = new Set();

/** Dopisuje wpis {ts, via, ...entry}; treść zapytania przycinana do 4000 znaków. */
export function auditQuery(via, entry, file = QUERY_LOG) {
  const record = { ts: new Date().toISOString(), via, ...entry };
  if (typeof record.query === 'string') record.query = record.query.slice(0, 4000);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (err) {
    if (!warned.has(file)) {
      warned.add(file);
      console.error(`ostrzeżenie: log zapytań ${file} niedostępny (${err?.code ?? 'błąd zapisu'}) — zapytania nie są rejestrowane`);
    }
  }
}
