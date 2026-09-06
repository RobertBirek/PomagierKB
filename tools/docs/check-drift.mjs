#!/usr/bin/env node
// check-drift.mjs — wykrywa rozjazd dokumentacji z kodem.
//
// Dlaczego istnieje: audyt 2026-09-06 (D12-01, D12-02) znalazł tabelę tras opisującą
// 17 nieistniejących pozycji i pomijającą 17 istniejących, oraz katalog narzędzi MCP
// opisujący 4 z 11. Obie tabele zostały odtworzone z kodu ręcznie — i bez tego skryptu
// zdryfują ponownie przy pierwszej nowej trasie. To NIE jest generator: tabele są ręcznie
// grupowane i opisane, a automat by tę pracę zniszczył. Skrypt porównuje wyłącznie ZBIORY
// (metoda+ścieżka, nazwa narzędzia) i mówi, czego brakuje albo co jest zmyślone.
//
// Użycie: node tools/docs/check-drift.mjs [--json]
// Exit: 0 = zgodne, 1 = rozjazd (lista różnic na stdout), 2 = błąd wykonania.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTES_DIR = join(ROOT, 'apps/panel-api/src/routes');
const TOOLS_DIR = join(ROOT, 'apps/mcp-server/src/tools');
const DOC = join(ROOT, 'docs/design/backend-mcp.md');

const jsonOut = process.argv.includes('--json');

/** Trasy z kodu: `app.get('/x', …)`, `app.post<{…}>('/x', …)`, także wieloliniowe. */
function routesFromCode() {
  const found = new Set();
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    // app.<metoda> [generics] ( '<ścieżka>'   — generics mogą być wieloliniowe
    const re = /\bapp\.(get|post|put|patch|delete|head|options)\s*(?:<[\s\S]*?>)?\s*\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) found.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  // /openapi.json rejestruje plugin swagger, nie moduł tras
  const swagger = join(ROOT, 'apps/panel-api/src/plugins/swagger.ts');
  try {
    if (/'\/openapi\.json'/.test(readFileSync(swagger, 'utf8'))) found.add('GET /openapi.json');
  } catch {
    /* brak pluginu = brak trasy; nie jest to błąd tego skryptu */
  }
  return found;
}

/**
 * Trasy z dokumentu: wiersze tabel `| GET | \`/ścieżka\` | …`.
 * Prefiks `/api/v1` jest w dokumencie opisany nagłówkiem sekcji, a w kodzie dokłada go
 * rejestracja — dlatego porównujemy ścieżki BEZ niego, po obu stronach.
 */
function routesFromDoc() {
  const src = readFileSync(DOC, 'utf8');
  const found = new Set();
  const re = /^\|\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\|\s*`([^`?\s]+)/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    found.add(`${m[1]} ${m[2].replace(/^\/api\/v1/, '')}`);
  }
  return found;
}

/** Narzędzia MCP z kodu: `name: 'kb_…'` w tools/*.ts. */
function toolsFromCode() {
  const found = new Set();
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
    const re = /\bname:\s*'(kb_[a-z_]+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
  }
  return found;
}

/** Narzędzia MCP z dokumentu: wiersze `| \`kb_…\` |`. */
function toolsFromDoc() {
  const src = readFileSync(DOC, 'utf8');
  const found = new Set();
  const re = /^\|\s*`(kb_[a-z_]+)`\s*\|/gm;
  let m;
  while ((m = re.exec(src)) !== null) found.add(m[1]);
  return found;
}

function diff(code, doc) {
  return {
    missingInDoc: [...code].filter((x) => !doc.has(x)).sort(),
    missingInCode: [...doc].filter((x) => !code.has(x)).sort(),
  };
}

export function checkDrift() {
  const routes = diff(routesFromCode(), routesFromDoc());
  const tools = diff(toolsFromCode(), toolsFromDoc());
  return {
    routes: { ...routes, codeCount: routesFromCode().size, docCount: routesFromDoc().size },
    tools: { ...tools, codeCount: toolsFromCode().size, docCount: toolsFromDoc().size },
    ok:
      routes.missingInDoc.length === 0 &&
      routes.missingInCode.length === 0 &&
      tools.missingInDoc.length === 0 &&
      tools.missingInCode.length === 0,
  };
}

// Uruchomienie bezpośrednie (nie import z testu)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let result;
  try {
    result = checkDrift();
  } catch (err) {
    console.error(`[drift] błąd: ${err.message}`);
    process.exit(2);
  }
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const say = (label, d) => {
      console.log(`${label}: kod ${d.codeCount}, dokument ${d.docCount}`);
      for (const x of d.missingInDoc) console.log(`  BRAK W DOKUMENCIE: ${x}`);
      for (const x of d.missingInCode) console.log(`  NIE ISTNIEJE W KODZIE: ${x}`);
    };
    say('Trasy panel-api (docs/design/backend-mcp.md §2.2)', result.routes);
    say('Narzędzia MCP (§7.4)', result.tools);
    console.log(result.ok ? 'OK — dokumentacja zgodna z kodem' : 'ROZJAZD — popraw tabele');
  }
  process.exit(result.ok ? 0 : 1);
}
