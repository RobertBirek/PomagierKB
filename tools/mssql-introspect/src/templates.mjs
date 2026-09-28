// Katalog szablonów SQL (tools/mssql-introspect/templates/<obszar>/<id>.md) — czysta logika bez MCP
// i bez sterownika: parsowanie nagłówka YAML i bloku T-SQL, walidacja reguł katalogu, wyszukiwanie
// po tytule i pytaniach, walidacja parametrów. Spec: docs/superpowers/specs/2026-09-28-erp-analyst-design.md

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkReadOnly } from './mcp-readonly.mjs';

export const AREAS = ['sprzedaz', 'finanse', 'magazyn'];
export const PARAM_TYPES = ['date', 'int', 'number', 'text', 'enum'];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PARAM_NAME_RE = /^[a-z][a-z0-9_]*$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_TEXT_MAX = 100;
const RULES_FILE = '_zasady.md';
export const SEARCH_LIMIT = 10;
// Słowa pytające i spójniki — bez znaczenia dla dopasowania szablonu.
const STOP_WORDS = new Set(['ile', 'jak', 'jaki', 'jaka', 'jakie', 'czy', 'ktore', 'ktory', 'ktora', 'dla', 'nas', 'mamy', 'sie', 'oraz', 'jest', 'byl', 'tym', 'ten', 'ta', 'to', 'po', 'na', 'do', 'od', 'w', 'we', 'z', 'ze', 'i', 'a', 'o']);

const fail = (reason) => ({ ok: false, reason });
const ok = (value) => ({ ok: true, value });

/** Normalizacja do porównań: małe litery, bez diakrytyków; `ł` nie rozkłada się w NFD, więc jawnie. */
export function normalizeText(s) {
  return String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Tokeny z samych cyfr (rok, „top 10") nie odróżniają szablonów — trafiałyby w przykładowe pytania.
function tokenize(s) {
  return normalizeText(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !STOP_WORDS.has(w));
}

/** Rdzeń słowa do dopasowania odmian („należności"/„należność", „marki"/„marek"). */
function stem(w) {
  return w.length <= 4 ? w : w.slice(0, Math.max(4, w.length - 3));
}

function isCalendarDate(s) {
  const m = typeof s === 'string' ? s.match(DATE_RE) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** YAML może oddać datę jako Date (inne schematy) — sprowadzamy do RRRR-MM-DD. */
function asDateString(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return typeof v === 'string' ? v.trim() : v;
}

/** Nagłówek YAML + treść; toleruje BOM i CRLF. */
export function splitFrontMatter(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { meta: m[1], body: m[2] } : null;
}

/**
 * Nazwy parametrów `@x` w SQL (bez `@@zmiennych`, komentarzy, literałów i identyfikatorów w cudzysłowach).
 * Wielkość liter bez zmian: klucze deklaracji są małymi literami (PARAM_NAME_RE), więc `@Od` = błąd katalogu.
 */
export function extractParamNames(sql) {
  const cleaned = String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/N?'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/\[(?:\]\]|[^\]])*\]/g, '[]');
  const names = new Set();
  for (const m of cleaned.matchAll(/(^|[^@\w])@([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[2]);
  return [...names].sort();
}

/** Koercja jednej wartości do typu parametru (wejście z MCP/CLI bywa tekstem). */
export function coerceValue(def, v) {
  switch (def.type) {
    case 'date': {
      const s = asDateString(v);
      return isCalendarDate(s) ? ok(s) : fail('oczekiwano daty RRRR-MM-DD');
    }
    case 'int': {
      const n = typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v;
      return Number.isSafeInteger(n) ? ok(n) : fail('oczekiwano liczby całkowitej');
    }
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? ok(n) : fail('oczekiwano liczby');
    }
    case 'text': {
      if (typeof v !== 'string' || v.trim() === '') return fail('oczekiwano niepustego tekstu');
      return v.length <= def.maxLength ? ok(v) : fail(`tekst dłuższy niż ${def.maxLength} znaków`);
    }
    case 'enum': {
      const hit = def.values.find((x) => String(x) === String(v));
      return hit === undefined ? fail(`dozwolone: ${def.values.join(', ')}`) : ok(hit);
    }
    default:
      return fail(`nieznany typ ${def.type}`);
  }
}

function normalizeParamDef(name, def) {
  const err = (msg) => ({ error: `parametr ${name}: ${msg}` });
  if (!PARAM_NAME_RE.test(name)) return err('nazwa musi pasować do [a-z][a-z0-9_]*');
  if (!def || typeof def !== 'object' || Array.isArray(def)) return err('definicja musi być mapą');
  if (!PARAM_TYPES.includes(def.type)) return err(`type ∈ ${PARAM_TYPES.join('|')}`);
  if (typeof def.description !== 'string' || def.description.trim() === '') return err('description wymagany');
  const out = { type: def.type, description: def.description.trim(), required: def.required !== false };
  if (def.type === 'text') {
    out.maxLength = def.maxLength ?? DEFAULT_TEXT_MAX;
    if (!Number.isInteger(out.maxLength) || out.maxLength < 1 || out.maxLength > 4000) return err('maxLength 1–4000');
  }
  if (def.type === 'enum') {
    if (!Array.isArray(def.values) || def.values.length === 0) return err('enum wymaga niepustego values');
    out.values = def.values;
  }
  const ex = coerceValue(out, def.example);
  if (!ex.ok) return err(`example — ${ex.reason}`);
  out.example = ex.value;
  if (def.default !== undefined) {
    if (out.required) return err('default tylko z required: false');
    const d = coerceValue(out, def.default);
    if (!d.ok) return err(`default — ${d.reason}`);
    out.default = d.value;
  }
  return { def: out };
}

/** Jeden plik szablonu → {template} albo {error} z nazwą pliku i listą problemów. */
export function parseTemplate(raw, { file, area }) {
  const fm = splitFrontMatter(raw);
  if (!fm) return { error: `${file}: brak nagłówka YAML (--- … ---)` };
  let meta;
  try {
    meta = parseYaml(fm.meta) ?? {};
  } catch (e) {
    return { error: `${file}: YAML: ${e.message.split('\n')[0]}` };
  }
  if (typeof meta !== 'object' || Array.isArray(meta)) return { error: `${file}: YAML: nagłówek musi być mapą` };
  const problems = [];
  const { id } = meta;
  if (typeof id !== 'string' || !ID_RE.test(id)) problems.push('id: wymagany kebab-case');
  else if (basename(file, '.md') !== id) problems.push(`id "${id}" ≠ nazwa pliku`);
  if (typeof meta.title !== 'string' || meta.title.trim() === '') problems.push('title: wymagany');
  if (meta.area !== area) problems.push(`area: "${meta.area}" ≠ katalog "${area}"`);
  const questions = Array.isArray(meta.questions) ? meta.questions.filter((q) => typeof q === 'string' && q.trim() !== '').map((q) => q.trim()) : [];
  if (questions.length === 0) problems.push('questions: co najmniej jedno pytanie');
  const verified = asDateString(meta.verified);
  if (!isCalendarDate(verified)) problems.push('verified: data RRRR-MM-DD');
  const order = meta.order ?? 1000;
  if (!Number.isInteger(order)) problems.push('order: liczba całkowita');
  const blocks = [...fm.body.matchAll(/```sql\n([\s\S]*?)```/g)];
  if (blocks.length !== 1) problems.push(`dokładnie jeden blok \`\`\`sql (jest ${blocks.length})`);
  const sql = blocks[0]?.[1].trim() ?? '';
  const rawParams = meta.params ?? {};
  const params = {};
  if (typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    problems.push('params: mapa nazwa → definicja');
  } else {
    for (const [name, def] of Object.entries(rawParams)) {
      const p = normalizeParamDef(name, def);
      if (p.error) problems.push(p.error);
      else params[name] = p.def;
    }
  }
  if (sql !== '') {
    const used = extractParamNames(sql);
    const declared = typeof rawParams === 'object' && !Array.isArray(rawParams) ? Object.keys(rawParams) : [];
    const undeclared = used.filter((n) => !declared.includes(n));
    const unused = declared.filter((n) => !used.includes(n));
    if (undeclared.length) problems.push(`parametry w SQL niezadeklarowane: ${undeclared.join(', ')}`);
    if (unused.length) problems.push(`parametry zadeklarowane, nieużyte w SQL: ${unused.join(', ')}`);
    const gate = checkReadOnly(sql);
    if (!gate.ok) problems.push(`SQL: ${gate.reason}`);
  }
  if (problems.length) return { error: `${file}: ${problems.join('; ')}` };
  return { template: { id, title: meta.title.trim(), area, order, questions, params, verified, sql, body: fm.body.trim(), file } };
}

/**
 * Plik zasad obszaru → {rules, meta} albo {error}. Zdejmuje front matter (metadane źródła: owner,
 * license, date — trafiają do nagłówka dokumentu KPI) i wiodący nagłówek `# ` (dokument ma własny tytuł).
 */
export function parseRules(raw, { file }) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const fm = splitFrontMatter(text);
  let meta = {};
  if (fm) {
    try {
      meta = parseYaml(fm.meta) ?? {};
    } catch (e) {
      return { error: `${file}: YAML: ${e.message.split('\n')[0]}` };
    }
    if (typeof meta !== 'object' || Array.isArray(meta)) return { error: `${file}: YAML: nagłówek musi być mapą` };
    meta = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, asDateString(v)]));
  }
  const body = (fm ? fm.body : text).trim().replace(/^# [^\n]*\n*/, '');
  return { rules: body.trim(), meta };
}

/** Cały katalog: szablony (posortowane obszar → order → id), zasady obszarów z metadanymi, błędy plików. */
export function loadCatalog(dir) {
  const templates = [];
  const errors = [];
  const rules = {};
  const rulesMeta = {};
  const seen = new Map();
  for (const area of AREAS) {
    let files;
    try {
      files = readdirSync(join(dir, area)).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue; // brak katalogu obszaru = brak szablonów
    }
    for (const f of files) {
      const rel = `${area}/${f}`;
      const raw = readFileSync(join(dir, area, f), 'utf8');
      if (f === RULES_FILE) {
        const r = parseRules(raw, { file: rel });
        if (r.error) errors.push(r.error);
        else {
          rules[area] = r.rules;
          rulesMeta[area] = r.meta;
        }
        continue;
      }
      const r = parseTemplate(raw, { file: rel, area });
      if (r.error) {
        errors.push(r.error);
      } else if (seen.has(r.template.id)) {
        errors.push(`${rel}: id "${r.template.id}" już użyte w ${seen.get(r.template.id)}`);
      } else {
        seen.set(r.template.id, rel);
        templates.push(r.template);
      }
    }
  }
  templates.sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area) || a.order - b.order || a.id.localeCompare(b.id));
  return { templates, rules, rulesMeta, errors };
}

/**
 * Dopasowanie słów zapytania do id/tytułu/pytań; wynik malejąco po liczbie trafionych słów, najwyżej
 * `limit` pozycji (domyślnie SEARCH_LIMIT). Bez słów zapytania — cała pula (lista obszaru/katalogu).
 */
export function searchTemplates(templates, { area, query, limit = SEARCH_LIMIT } = {}) {
  const pool = area ? templates.filter((t) => t.area === area) : templates;
  const words = tokenize(query ?? '');
  if (words.length === 0) return pool;
  const scored = pool.map((t) => {
    const hay = tokenize([t.id.replace(/-/g, ' '), t.title, ...t.questions].join(' '));
    const hits = words.filter((w) => hay.some((h) => h.startsWith(stem(w)) || w.startsWith(stem(h)))).length;
    return { t, hits };
  });
  return scored.filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits).slice(0, limit).map((s) => s.t);
}

/** Walidacja wejścia run_template: typy, wymagane, nieznane klucze, default, zakresy od*<do*. */
export function validateParams(template, input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('params: oczekiwano obiektu {nazwa: wartość}');
  const names = Object.keys(template.params);
  const unknown = Object.keys(input).filter((k) => !names.includes(k));
  if (unknown.length) return fail(`nieznane parametry: ${unknown.join(', ')} (dozwolone: ${names.join(', ') || 'brak'})`);
  const values = {};
  for (const [name, def] of Object.entries(template.params)) {
    const v = input[name];
    if (v === undefined || v === null || v === '') {
      if (def.required) return fail(`brak wymaganego parametru ${name} (${def.type}, np. ${def.example})`);
      values[name] = def.default ?? null;
      continue;
    }
    const c = coerceValue(def, v);
    if (!c.ok) return fail(`${name}: ${c.reason}`);
    values[name] = c.value;
  }
  // Konwencja zakresów półotwartych: od<sufiks> musi być wcześniej niż do<sufiks>.
  for (const [name, def] of Object.entries(template.params)) {
    if (def.type !== 'date' || !name.startsWith('od')) continue;
    const pair = `do${name.slice(2)}`;
    if (template.params[pair]?.type === 'date' && values[name] && values[pair] && values[name] >= values[pair]) {
      return fail(`${name} (${values[name]}) musi być wcześniej niż ${pair} (${values[pair]}) — zakres [${name}, ${pair}) jest pusty`);
    }
  }
  return { ok: true, values };
}

/** Data kalendarzowa RRRR-MM-DD w strefie firmy (nie UTC — po północy czasu polskiego UTC to jeszcze wczoraj). */
export function localDate(now = new Date(), timeZone = 'Europe/Warsaw') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Podmienia datę `verified:` w nagłówku (reszta pliku bajt w bajt bez zmian, także końce linii CRLF). */
export function setVerified(raw, date) {
  if (!isCalendarDate(date)) throw new Error(`setVerified: zła data ${date}`);
  const end = raw.search(/\r?\n---(?:\r?\n|$)/);
  if (!/^\uFEFF?---/.test(raw) || end < 0) throw new Error('setVerified: brak zamykającego --- nagłówka YAML');
  const head = raw.slice(0, end);
  if (!/^verified:.*$/m.test(head)) throw new Error('setVerified: brak linii verified w nagłówku');
  return head.replace(/^verified:.*$/m, `verified: ${date}`) + raw.slice(end);
}
