// Narzędzia serwera MCP mssql (execute_sql, list_templates, run_template) bez protokołu i bez
// własnego połączenia: pula, typy sterownika, katalog szablonów i log są wstrzykiwane (testy podają
// atrapy). Parametry szablonów idą WYŁĄCZNIE przez request.input — nigdy przez tekst SQL.

import { fileURLToPath } from 'node:url';
import { checkReadOnly } from './mcp-readonly.mjs';
import { loadCatalog, searchTemplates, validateParams } from './templates.mjs';

export const MAX_ROWS = 200;
export const MAX_CHARS = 60_000;
export const DEFAULT_CATALOG_DIR = process.env.MSSQL_TEMPLATES_DIR ?? fileURLToPath(new URL('../templates/', import.meta.url));

export const TOOL_DEFS = [
  {
    name: 'execute_sql',
    description:
      'Wykonuje JEDNO zapytanie SELECT (tylko odczyt) na produkcyjnej bazie Subiekt GT ilovelighting ' +
      '(Magnum_Profi). Zapis, DDL, procedury i wiele zapytań są odrzucane. Zwraca wiersze jako JSON ' +
      `(do ${MAX_ROWS} wierszy). Najpierw sprawdź list_templates — szablon ma zweryfikowane reguły instancji.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string', description: 'Zapytanie SELECT (jedno, bez ";")' } },
    },
  },
  {
    name: 'list_templates',
    description:
      'Lista zweryfikowanych szablonów SQL (KPI sprzedaży, finansów, magazynu) dla instancji Magnum_Profi: ' +
      'id, tytuł, parametry z przykładami, przykładowe pytania, data weryfikacji. Filtr po obszarze i słowach pytania.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        area: { type: 'string', enum: ['sprzedaz', 'finanse', 'magazyn'] },
        query: { type: 'string', description: 'Słowa z pytania, np. "należności przeterminowane"' },
      },
    },
  },
  {
    name: 'run_template',
    description:
      'Wykonuje szablon SQL o danym id z parametrami (typowane, przekazywane do sterownika — nie wklejane w SQL). ' +
      'Ta sama bramka tylko-do-odczytu i limity co execute_sql; w stopce id szablonu i data weryfikacji.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'id z list_templates' },
        params: { type: 'object', description: 'Parametry, np. {"od":"2026-09-01","do":"2026-10-01"}' },
      },
    },
  },
];

export function sqlTypeFor(def, value, sql) {
  switch (def.type) {
    case 'date': return sql.Date;
    case 'int': return sql.Int;
    case 'number': return sql.Decimal(18, 4);
    case 'text': return sql.NVarChar(def.maxLength);
    case 'enum':
      return Number.isInteger(value) ? sql.Int : sql.NVarChar(Math.max(...def.values.map((v) => String(v).length)));
    default: throw new Error(`nieznany typ parametru: ${def.type}`);
  }
}

/** Data → północ UTC (tedious ma domyślnie useUTC=true, więc granica dnia się nie przesuwa). */
export function toDriverValue(def, value) {
  if (value === null || value === undefined) return null;
  if (def.type === 'date') {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  return value;
}

function formatRows(rows, footer) {
  const capped = rows.slice(0, MAX_ROWS);
  let body = JSON.stringify(capped, null, 1);
  let note = `${rows.length} wierszy`;
  if (rows.length > MAX_ROWS) note += `, pokazano pierwsze ${MAX_ROWS}`;
  if (body.length > MAX_CHARS) {
    body = body.slice(0, MAX_CHARS);
    note += `, wynik przycięty do ${MAX_CHARS} znaków`;
  }
  return `${note}\n${body}${footer ? `\n— ${footer}` : ''}`;
}

const errText = (err) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export function createTools({ getPool, sql, catalogDir = DEFAULT_CATALOG_DIR, audit }) {
  async function executeSql(text) {
    const query = String(text ?? '');
    const gate = checkReadOnly(query);
    if (!gate.ok) {
      audit('mcp', { ok: false, reason: gate.reason, query });
      throw new Error(`odrzucone (tryb tylko-do-odczytu): ${gate.reason}`);
    }
    const started = Date.now();
    let res;
    try {
      res = await (await getPool()).request().query(query);
    } catch (err) {
      audit('mcp', { ok: false, reason: `błąd wykonania: ${errText(err)}`, query });
      throw err;
    }
    const rows = res.recordset ?? [];
    audit('mcp', { ok: true, rows: rows.length, ms: Date.now() - started, query });
    return formatRows(rows);
  }

  function listTemplates({ area, query } = {}) {
    const { templates, errors } = loadCatalog(catalogDir);
    const found = searchTemplates(templates, { area, query });
    const out = found.map((t) => ({
      id: t.id,
      title: t.title,
      area: t.area,
      params: Object.fromEntries(Object.entries(t.params).map(([n, d]) => [n, `${d.type}${d.required ? '' : '?'} — ${d.description} (np. ${d.example})`])),
      questions: t.questions,
      verified: t.verified,
    }));
    let text = `${out.length} szablon(ów)${query ? ` dla „${query}”` : ''}${area ? ` w obszarze ${area}` : ''}\n${JSON.stringify(out, null, 1)}`;
    if (errors.length) text += `\nBłędne pliki katalogu (pominięte):\n- ${errors.join('\n- ')}`;
    return text;
  }

  async function executeTemplate(id, params) {
    const { templates, errors } = loadCatalog(catalogDir);
    const template = templates.find((t) => t.id === id);
    if (!template) {
      const bad = errors.find((e) => e.includes(`/${id}.md:`));
      throw new Error(bad ? `szablon ${id} jest błędny: ${bad}` : `nieznany szablon: ${id} (użyj list_templates)`);
    }
    const v = validateParams(template, params ?? {});
    if (!v.ok) {
      audit('template', { templateId: id, ok: false, reason: v.reason, params: params ?? {} });
      throw new Error(`parametry: ${v.reason}`);
    }
    const gate = checkReadOnly(template.sql);
    if (!gate.ok) {
      audit('template', { templateId: id, ok: false, reason: gate.reason, params: v.values });
      throw new Error(`odrzucone (tryb tylko-do-odczytu): ${gate.reason}`);
    }
    const started = Date.now();
    let res;
    try {
      const req = (await getPool()).request();
      for (const [name, def] of Object.entries(template.params)) {
        req.input(name, sqlTypeFor(def, v.values[name], sql), toDriverValue(def, v.values[name]));
      }
      res = await req.query(template.sql);
    } catch (err) {
      audit('template', { templateId: id, ok: false, reason: `błąd wykonania: ${errText(err)}`, params: v.values });
      throw err;
    }
    const rows = res.recordset ?? [];
    const ms = Date.now() - started;
    audit('template', { templateId: id, ok: true, rows: rows.length, ms, params: v.values });
    return { template, rows, ms };
  }

  async function runTemplate({ id, params } = {}) {
    const { template, rows } = await executeTemplate(String(id ?? ''), params);
    return formatRows(rows, `szablon ${template.id} · zweryfikowany ${template.verified}`);
  }

  return { executeSql, listTemplates, executeTemplate, runTemplate };
}
