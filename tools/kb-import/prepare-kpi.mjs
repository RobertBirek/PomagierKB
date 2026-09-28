#!/usr/bin/env node
// Katalog szablonów SQL (tools/mssql-introspect/templates) + konwencje instancji → dokumenty IloveKB:
// kpi-sprzedaz.md, kpi-finanse.md, kpi-magazyn.md, konwencje-instancji.md — z TYMI SAMYMI tytułami
// i sourceUrl co przy imporcie 2026-09-14 (re-import zastępuje wersje; goldens po sourceRef).
// Manifest SCALANY z istniejącym (wpisy agregatów, dostawców, słowników zostają).
// Użycie: node tools/kb-import/prepare-kpi.mjs --out <out/docs> --source-base <url> [--templates <dir>] [--konwencje <plik>]

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

function paramLine(name, d) {
  const flags = [d.type, ...(d.required ? [] : ['opcjonalny']), ...(d.default !== undefined ? [`domyślnie ${d.default}`] : [])];
  const extra = d.type === 'enum' ? `; dozwolone: ${d.values.join(', ')}` : d.type === 'text' ? `; maks. ${d.maxLength} znaków` : '';
  return `- \`@${name}\` (${flags.join(', ')}) — ${d.description}; przykład: ${d.example}${extra}`;
}

export function renderAreaDoc({ area, templates, rules }) {
  const L = [`# ${DOCS[area].title}`, '', rules.trim(), ''];
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
    const text = renderAreaDoc({ area, templates, rules: catalog.rules[area] ?? '' });
    guard(d.file, text);
    files.push({ file: d.file, text });
    entries.push(entry({ ...d, category: 'mapowanie KPI → SQL', keywords: [PRODUCT, INSTANCE, ...d.keywords, ...templates.map((t) => t.title)], text, sourceBase, sourceFile: `templates/${area}` }));
  }
  const k = `${konwencje.trim()}\n`;
  guard(KONWENCJE.file, k);
  files.push({ file: KONWENCJE.file, text: k });
  entries.push(entry({ ...KONWENCJE, text: k, sourceBase, sourceFile: 'instance/konwencje-instancji.md' }));
  return { files, entries };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const out = opt('--out');
  const sourceBase = opt('--source-base');
  const tplDir = opt('--templates', fileURLToPath(new URL('../mssql-introspect/templates/', import.meta.url)));
  const konwFile = opt('--konwencje', fileURLToPath(new URL('../mssql-introspect/instance/konwencje-instancji.md', import.meta.url)));
  if (!out || !sourceBase) {
    console.error('użycie: prepare-kpi.mjs --out <out/docs> --source-base <url> [--templates <dir>] [--konwencje <plik>]');
    process.exit(2);
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
  mkdirSync(out, { recursive: true });
  for (const f of result.files) writeFileSync(join(out, f.file), f.text);
  const manifestPath = join(out, 'manifest.json');
  let previous = { entries: [] };
  try { previous = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* pierwszy przebieg */ }
  const mine = new Set(result.entries.map((e) => e.file));
  const kept = (previous.entries ?? []).filter((e) => !mine.has(e.file));
  writeFileSync(manifestPath, JSON.stringify({ ...previous, generatedAt: new Date().toISOString(), entries: [...kept, ...result.entries] }, null, 2));
  console.log(`szablonów: ${catalog.templates.length}, plików: ${result.files.length}, znaków: ${result.entries.reduce((a, e) => a + e.chars, 0)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
