#!/usr/bin/env node
// Katalog szablonów SQL (tools/mssql-introspect/templates) + konwencje instancji → dokumenty IloveKB:
// kpi-sprzedaz.md, kpi-finanse.md, kpi-magazyn.md, konwencje-instancji.md — z TYMI SAMYMI tytułami
// i sourceUrl co przy imporcie 2026-09-14 (re-import zastępuje wersje; goldens po sourceRef).
// Każdy dokument zaczyna się od front mattera źródła (owner/license/date — panel czyta metadane tylko
// z bloku na SAMYM początku) i ma dokładnie jeden nagłówek `# `.
// Manifest SCALANY z istniejącym (wpisy agregatów, dostawców, słowników zostają); uszkodzony = stop.
// Publikuje tylko ZATWIERDZONY katalog: niezacommitowane zmiany w templates/ lub instance/ = odmowa
// (kod 3), chyba że --allow-dirty (wyłącznie lokalny podgląd; refresh_ilovekb.sh go NIE podaje).
// Użycie: node tools/kb-import/prepare-kpi.mjs --out <out/docs> --source-base <url> [--templates <dir>] [--konwencje <plik>] [--allow-dirty]

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AREAS, loadCatalog } from '../mssql-introspect/src/templates.mjs';

export const MAX_DOC_CHARS = 95_000;
const PRODUCT = 'Subiekt GT (Magnum_Profi)';
const INSTANCE = 'Magnum_Profi';
const DOCS = {
  sprzedaz: { file: 'kpi-sprzedaz.md', slug: 'kpi-sprzedaz', title: 'Magnum_Profi — KPI: sprzedaż i marża (szablony SQL)', keywords: ['KPI sprzedaży', 'szablon SQL', 'dok__Dokument', 'dok_Pozycja', 'sl_GrupaTw'] },
  finanse: { file: 'kpi-finanse.md', slug: 'kpi-finanse', title: 'Magnum_Profi — KPI: finanse i klienci (szablony SQL)', keywords: ['KPI', 'SQL', 'rozrachunki', 'nz__Finanse', 'sl_FormaPlatnosci', 'kh_OdbDet'] },
  magazyn: { file: 'kpi-magazyn.md', slug: 'kpi-magazyn', title: 'Magnum_Profi — KPI: magazyn i zakupy (szablony SQL)', keywords: ['KPI', 'magazyn', 'zakupy', 'dok_MagRuch', 'FIFO', 'tw_SklepInternet'] },
};
const KONWENCJE = {
  file: 'konwencje-instancji.md', slug: 'konwencje', title: 'Magnum_Profi — konwencje i semantyka instancji', category: 'konwencje instancji',
  keywords: ['Magnum_Profi', 'konwencje', 'rola kontrahenta', 'klient hurtowy', 'pola własne', 'poziomy cen', 'marki', 'typy dokumentów', 'kanały sprzedaży'],
};
const HOST_RE = /192\.168\.|INSERTGT|DESKTOP-/;
// Metadane źródła dla obszaru, którego zasady ich nie mają (sprzedaż) — te same klucze co w IloveKB.
const DEFAULT_META = {
  owner: 'ilovelighting (instancja produkcyjna Magnum_Profi)',
  license: 'użytek wewnętrzny — mapowanie KPI na SQL, bez danych osobowych',
};
const FRONT_MATTER_RE = /^---\n[\s\S]*?\n---\n/;
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const APPROVED_PATHS = ['tools/mssql-introspect/templates', 'tools/mssql-introspect/instance'];

/** Blok front mattera: owner, license, pozostałe klucze zasad, na końcu date (deterministyczna). */
function frontMatter(meta, date) {
  const fields = { ...DEFAULT_META, ...meta };
  delete fields.date;
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ').trim()}`);
  return ['---', ...lines, `date: ${date}`, '---'].join('\n');
}

export function paramLine(name, d) {
  const flags = [d.type, ...(d.required ? [] : ['opcjonalny']), ...(d.default !== undefined ? [`domyślnie ${d.default}`] : [])];
  const extra = d.type === 'enum' ? `; dozwolone: ${d.values.join(', ')}` : d.type === 'text' ? `; maks. ${d.maxLength} znaków` : '';
  return `- \`@${name}\` (${flags.join(', ')}) — ${d.description}; przykład: ${d.example}${extra}`;
}

export function renderAreaDoc({ area, templates, rules, meta = {} }) {
  // Data dokumentu = najpóźniejsza weryfikacja jego szablonów (nie dzień generowania — wynik deterministyczny).
  const date = templates.map((t) => t.verified).sort().at(-1);
  const L = [frontMatter(meta, date), `# ${DOCS[area].title}`, '', rules.trim(), ''];
  for (const t of [...templates].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    L.push(`## ${t.title}`, '', t.body.trim(), '');
    const params = Object.entries(t.params);
    L.push(params.length ? `Parametry:\n${params.map(([n, d]) => paramLine(n, d)).join('\n')}` : 'Parametry: brak.', '');
    L.push(`Przykładowe pytania: ${t.questions.join(' · ')}`, '');
    L.push(`Wykonanie: \`run_template ${t.id}\` (serwer MCP mssql) albo \`node tools/mssql-introspect/run-template.mjs ${t.id}\`. Zweryfikowano na produkcji: ${t.verified}.`, '');
  }
  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function entry({ file, slug, title, category, keywords, text, sourceBase, sourceFile }) {
  return { file, title, sourceUrl: `${sourceBase}#dokumentacja/instancja/${slug}`, category, product: PRODUCT, part: 1, parts: 1, chars: text.length, keywords, sourceFile };
}

function guard(file, text) {
  if (HOST_RE.test(text)) throw new Error(`${file}: adres hosta bazy w treści — przerywam`);
  if (text.length > MAX_DOC_CHARS) throw new Error(`${file}: ${text.length} znaków > ${MAX_DOC_CHARS} (limit uploadu 100000) — podziel obszar`);
}

export function generateKpiDocs({ catalog, konwencje, sourceBase }) {
  if (!sourceBase) throw new Error('brak sourceBase (--source-base)');
  const files = [];
  const entries = [];
  for (const area of AREAS) {
    const templates = catalog.templates.filter((t) => t.area === area);
    if (templates.length === 0) continue;
    const d = DOCS[area];
    const text = renderAreaDoc({ area, templates, rules: catalog.rules[area] ?? '', meta: catalog.rulesMeta?.[area] ?? {} });
    guard(d.file, text);
    files.push({ file: d.file, text });
    entries.push(entry({ ...d, category: 'mapowanie KPI → SQL', keywords: [PRODUCT, INSTANCE, ...d.keywords, ...templates.map((t) => t.title)], text, sourceBase, sourceFile: `templates/${area}` }));
  }
  const k = `${konwencje.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()}\n`;
  if (!FRONT_MATTER_RE.test(k)) throw new Error(`${KONWENCJE.file}: brak front mattera (owner/license/date) na początku pliku`);
  if (k.split('\n').filter((l) => l.startsWith('# ')).length !== 1) throw new Error(`${KONWENCJE.file}: wymagany dokładnie jeden nagłówek \`# \``);
  guard(KONWENCJE.file, k);
  files.push({ file: KONWENCJE.file, text: k });
  entries.push(entry({ ...KONWENCJE, text: k, sourceBase, sourceFile: 'instance/konwencje-instancji.md' }));
  return { files, entries };
}

/** Scalenie manifestu: `previousRaw` = treść istniejącego manifest.json albo null (brak pliku). */
export function mergeManifest(previousRaw, entries, generatedAt) {
  let previous = { entries: [] };
  if (previousRaw !== null) {
    try {
      previous = JSON.parse(previousRaw);
    } catch (err) {
      throw new Error(`manifest.json jest uszkodzony (${err.message}) — nie nadpisuję; napraw albo usuń plik`);
    }
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('manifest.json jest uszkodzony (oczekiwano obiektu) — nie nadpisuję');
  }
  const mine = new Set(entries.map((e) => e.file));
  const kept = (Array.isArray(previous.entries) ? previous.entries : []).filter((e) => !mine.has(e.file));
  return { ...previous, generatedAt, entries: [...kept, ...entries] };
}

/** Niezacommitowane zmiany katalogu (git status --porcelain) — pusty string = czysto. */
function uncommittedCatalogChanges() {
  return execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', ...APPROVED_PATHS], { encoding: 'utf8' }).trim();
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const out = opt('--out');
  const sourceBase = opt('--source-base');
  const tplDir = opt('--templates', fileURLToPath(new URL('../mssql-introspect/templates/', import.meta.url)));
  const konwFile = opt('--konwencje', fileURLToPath(new URL('../mssql-introspect/instance/konwencje-instancji.md', import.meta.url)));
  if (!out || !sourceBase) {
    console.error('użycie: prepare-kpi.mjs --out <out/docs> --source-base <url> [--templates <dir>] [--konwencje <plik>] [--allow-dirty]');
    process.exit(2);
  }
  if (!args.includes('--allow-dirty')) {
    let dirty;
    try {
      dirty = uncommittedCatalogChanges();
    } catch (err) {
      console.error(`nie mogę sprawdzić stanu katalogu w git (${err.message.split('\n')[0]}) — dokumenty NIE zostały wygenerowane`);
      process.exit(3);
    }
    if (dirty) {
      console.error(`niezatwierdzone zmiany w katalogu szablonów/konwencjach — dokumenty NIE zostały wygenerowane (publikujemy tylko zacommitowany katalog; --allow-dirty wyłącznie do lokalnego podglądu):\n${dirty}`);
      process.exit(3);
    }
  }
  const catalog = loadCatalog(tplDir);
  if (catalog.errors.length) {
    console.error(`błędne szablony — dokumenty NIE zostały wygenerowane:\n- ${catalog.errors.join('\n- ')}`);
    process.exit(3);
  }
  let result;
  try {
    result = generateKpiDocs({ catalog, konwencje: readFileSync(konwFile, 'utf8'), sourceBase });
  } catch (err) {
    console.error(`błąd: ${err.message}`);
    process.exit(3);
  }
  const manifestPath = join(out, 'manifest.json');
  let manifest;
  try {
    let previousRaw = null;
    try {
      previousRaw = readFileSync(manifestPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // pierwszy przebieg = brak pliku; inny błąd = stop
    }
    manifest = mergeManifest(previousRaw, result.entries, new Date().toISOString());
  } catch (err) {
    console.error(`błąd: ${err.message}`);
    process.exit(3);
  }
  mkdirSync(out, { recursive: true });
  for (const f of result.files) writeFileSync(join(out, f.file), f.text);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`szablonów: ${catalog.templates.length}, plików: ${result.files.length}, znaków: ${result.entries.reduce((a, e) => a + e.chars, 0)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
