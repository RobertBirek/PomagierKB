#!/usr/bin/env node
// Dokumentacja bazy danych: scala żywy katalog (dump-schema → catalog.json), oficjalną
// Dokumentacja_DB.xml (opisy), Skrypty_SQL (definicje widoków/funkcji/procedur) i
// Dokumentacja_zmian_DB.xml → pliki .md + manifest + raport różnic.
// Użycie: node tools/kb-import/prepare-db.mjs --live <catalog.json> --docs <Dokumentacja_DB.xml>
//         --sql <katalog Skrypty_SQL> [--changes <Dokumentacja_zmian_DB.xml>] --out <katalog> [--product "InsERT GT"]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { renderCatalogToFiles } from './lib/catalog-render.mjs';
import { packSections } from './lib/catalog-md.mjs';
import { parseDbChangesXml, parseDbDocXml, renderDbChanges } from './lib/insert-dbdoc.mjs';
import { mergeDocsIntoCatalog, renderDiff } from './lib/catalog-merge.mjs';
import { DEFINITION_CAPS, attachDefinitions, loadSqlScripts } from './lib/sql-scripts.mjs';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const livePath = opt('--live');
const docsPath = opt('--docs');
const sqlDir = opt('--sql');
const changesPath = opt('--changes');
const outDir = opt('--out');
const productLabel = opt('--product', 'InsERT GT');
// sourceUrl musi być http(s) (walidacja POST /content) — baza = folder Drive z dokumentacją producenta.
const changesLabel = opt('--changes-label', null); // np. "1.89 → 1.89 HF1" — numery buildów w XML nie mówią użytkownikowi nic
const sourceBase = opt('--source-base', 'https://drive.google.com/drive/folders/1CRdwPl3SMF-sNS2bt83XvMbyFopeRded');
if (!livePath || !docsPath || !outDir) {
  console.error('użycie: prepare-db.mjs --live catalog.json --docs Dokumentacja_DB.xml [--sql dir] [--changes xml] --out dir');
  process.exit(2);
}

/** XML producenta jest w windows-1250 (deklaracja w prologu). */
function readCp1250(path) {
  return iconv.decode(readFileSync(path), 'windows-1250');
}

const catalog = JSON.parse(readFileSync(livePath, 'utf8'));
const docs = parseDbDocXml(readCp1250(docsPath));
console.log(`dokumentacja: wersja ${docs.version}, tabel ${Object.keys(docs.tables).length}`);
const diff = mergeDocsIntoCatalog(catalog, docs);
console.log(`opisane tabele: ${diff.describedTables}, kolumny: ${diff.describedColumns}; tylko-docs tabel: ${diff.docsOnlyTables.length}, tylko-baza tabel: ${diff.liveOnlyTables.length}, różnic typów: ${diff.typeMismatch.length}`);
if (sqlDir) {
  const defs = loadSqlScripts(sqlDir);
  const st = attachDefinitions(catalog, defs);
  console.log(`skrypty SQL: ${defs.size} definicji; dopasowane ${st.matched}, bez definicji ${st.missing}`);
}

mkdirSync(outDir, { recursive: true });
const database = catalog.meta?.database ?? '?';
const host = catalog.meta?.target ?? '?';
const date = new Date().toISOString().slice(0, 10);
const sourceName = `żywa baza MSSQL ${database} na ${host} + dokumentacja producenta ${docs.version} + skrypty SQL`;
const entries = renderCatalogToFiles(catalog, {
  outDir,
  productLabel,
  sourceName,
  sourceUrlBase: `${sourceBase}/baza-danych/${database}`,
  date,
  keywordsBase: [productLabel, 'baza danych', 'SQL Server', 'Subiekt GT', database],
  definitionCaps: DEFINITION_CAPS,
});
const fm = ''; // patrz prepare.mjs — proweniencja w tekście, front-matter po wdrożeniu poprawki GAP-03
const diffBody = renderDiff(diff, { productLabel, database, sourceName: `${host}` });
// Raport bywa długi (setki różnic typów) — dzielimy po sekcjach H2 jak inne dokumenty.
const diffSections = diffBody.split(/\n(?=## )/).map((t, i) => ({ name: i === 0 ? 'wstęp' : t.split('\n')[0].replace(/^## /, ''), text: t + '\n' }));
const diffTitle = `${productLabel} — różnice: dokumentacja bazy ${diff.docsVersion} a żywa baza ${database}`;
for (const p of packSections(diffSections.slice(1), { title: diffTitle, intro: diffSections[0].text.split('\n').slice(2).join('\n').trim(), maxChars: 80_000 })) {
  const file = p.parts > 1 ? `99-roznice-dokumentacja-vs-baza-${p.part}.md` : '99-roznice-dokumentacja-vs-baza.md';
  const text = fm + p.text;
  writeFileSync(join(outDir, file), text);
  entries.push({ file, title: p.title, sourceUrl: `${sourceBase}/baza-danych/${database}#dokumentacja/roznice${p.parts > 1 ? `/${p.part}` : ''}`, category: 'opis tabeli bazy danych', product: productLabel, part: p.part, parts: p.parts, chars: text.length });
}
if (changesPath) {
  const changes = parseDbChangesXml(readCp1250(changesPath));
  const t = fm + renderDbChanges(changes, productLabel, changesLabel);
  writeFileSync(join(outDir, '98-zmiany-bazy-danych.md'), t);
  entries.push({ file: '98-zmiany-bazy-danych.md', title: `${productLabel} — zmiany w bazie danych ${changesLabel ? `${changesLabel} (` : ''}${changes.oldVersion} → ${changes.newVersion}${changesLabel ? ')' : ''}`, sourceUrl: `${sourceBase}/baza-danych/${database}#dokumentacja/zmiany-bazy/${changes.newVersion}`, category: 'zmiany w wersji', product: productLabel, part: 1, parts: 1, chars: t.length });
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ source: sourceName, entries }, null, 2));
writeFileSync(join(outDir, 'diff.json'), JSON.stringify(diff, null, 1));
const total = entries.reduce((a, e) => a + e.chars, 0);
console.log(`plików: ${entries.length}, łącznie ${total} znaków`);
