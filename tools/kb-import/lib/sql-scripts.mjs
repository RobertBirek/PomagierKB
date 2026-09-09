// Definicje obiektów SQL ze skryptów producenta (Skrypty_SQL_<wersja>.zip: Views/, Functions/,
// Stored Procedures/, Tables/, Types/). Żywa baza InsERT ma obiekty WITH ENCRYPTION, więc to
// jedyne źródło treści widoków/procedur. Nazwa pliku = `<schema>.<nazwa>.sql`.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Usuwa opakowanie SET QUOTED_IDENTIFIER/ANSI_NULLS + GO i zostawia właściwą definicję. */
export function stripScriptWrapper(sql) {
  const lines = sql.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^GO$/i.test(t)) continue;
    if (/^SET (QUOTED_IDENTIFIER|ANSI_NULLS) (ON|OFF)$/i.test(t)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** Klucz `schema.nazwa` z nazwy pliku `schema.nazwa.sql`; null gdy inny wzorzec. */
export function objectKeyFromFile(filename) {
  const m = /^([^.]+)\.(.+)\.sql$/i.exec(filename);
  return m ? `${m[1]}.${m[2]}` : null;
}

const KIND_DIRS = [
  ['Views', 'VIEW'],
  ['Functions', 'FUNCTION'],
  ['Stored Procedures', 'PROCEDURE'],
];

/** Wczytuje definicje: Map(`schema.nazwa` → {kind, definition, file}). */
export function loadSqlScripts(rootDir) {
  const defs = new Map();
  for (const [dir, kind] of KIND_DIRS) {
    let files;
    try {
      files = readdirSync(join(rootDir, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      const key = objectKeyFromFile(f);
      if (!key) continue;
      const raw = readFileSync(join(rootDir, dir, f), 'utf8');
      defs.set(key.toLowerCase(), { key, kind, definition: stripScriptWrapper(raw), file: `${dir}/${f}` });
    }
  }
  return defs;
}

/** Limity długości definicji per typ obiektu (znaki) — kontrola liczby chunków w KB. */
export const DEFINITION_CAPS = {
  VIEW: 4000,
  SQL_SCALAR_FUNCTION: 1500,
  SQL_INLINE_TABLE_VALUED_FUNCTION: 2500,
  SQL_TABLE_VALUED_FUNCTION: 2500,
  SQL_STORED_PROCEDURE: 700,
  SQL_TRIGGER: 700,
};

/** Wstrzykuje definicje ze skryptów do modułów katalogu bez definicji. Zwraca statystyki. */
export function attachDefinitions(catalog, defs) {
  const stats = { matched: 0, missing: 0, alreadyHad: 0 };
  for (const m of catalog.modules) {
    if (m.definition) {
      stats.alreadyHad += 1;
      continue;
    }
    const d = defs.get(`${m.schema}.${m.name}`.toLowerCase());
    if (d) {
      m.definition = d.definition;
      m.definitionSource = d.file;
      stats.matched += 1;
    } else {
      stats.missing += 1;
    }
  }
  return stats;
}
