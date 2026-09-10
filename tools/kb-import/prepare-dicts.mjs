#!/usr/bin/env node
// Słowniki `sl_*` (dump-dictionaries.mjs → dictionaries.json) + opisy z Dokumentacja_DB.xml → Markdown:
// każda tabela = sekcja H3 z opisem, opisami kolumn i wierszami jako listą „wartość kolumn". Plus dokument
// z ograniczeniami CHECK (reguły biznesowe zakodowane w bazie). Bez danych osobowych (filtr w dumpie).
// Użycie: node tools/kb-import/prepare-dicts.mjs --dicts <dictionaries.json> --docs <Dokumentacja_DB.xml> --out <out/dicts>

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { packSections, modulePrefix } from './lib/catalog-md.mjs';
import { parseDbDocXml } from './lib/insert-dbdoc.mjs';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const dictsPath = opt('--dicts');
const docsPath = opt('--docs');
const outDir = opt('--out');
const productLabel = opt('--product', 'InsERT GT');
const sourceBase = opt('--source-base', 'https://drive.google.com/drive/folders/1CRdwPl3SMF-sNS2bt83XvMbyFopeRded');
if (!dictsPath || !outDir) {
  console.error('użycie: prepare-dicts.mjs --dicts dictionaries.json [--docs Dokumentacja_DB.xml] --out dir');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const dump = JSON.parse(readFileSync(dictsPath, 'utf8'));
const docs = docsPath ? parseDbDocXml(iconv.decode(readFileSync(docsPath), 'windows-1250')) : { tables: {} };
const docTable = (name) => Object.values(docs.tables).find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null;
const PROVENANCE = `Wartości z bazy ${dump.database} (InsERT GT 1.89 HF1) odczytane ${dump.generatedAt.slice(0, 10)}; kolumny osobowe pominięte. Część wpisów jest predefiniowana przez InsERT (kolumna *CzySystemowa*), część zdefiniowana przez użytkownika bazy. Właściciel treści: InsERT S.A.`;

const fmtVal = (v) => (v === null || v === undefined ? null : typeof v === 'boolean' ? (v ? 'tak' : 'nie') : String(v).replace(/\s+/g, ' ').trim());

/** Sekcja jednej tabeli słownikowej. */
export function renderDictionary(d, doc) {
  const L = [];
  L.push(`### ${d.table}`);
  L.push('');
  if (doc?.description) L.push(`Opis tabeli: ${doc.description}`, '');
  const colDesc = new Map((doc?.fields ?? []).map((f) => [f.name.toLowerCase(), f.description]));
  L.push(`Kolumny (${d.columns.length}): ${d.columns.map((c) => (colDesc.get(c.toLowerCase()) ? `\`${c}\` (${colDesc.get(c.toLowerCase())})` : `\`${c}\``)).join(', ')}.`);
  L.push('');
  L.push(`Wartości (${d.values.length}${d.rows > d.values.length ? ` z ${d.rows}` : ''}):`);
  for (const row of d.values) {
    const parts = [];
    for (const c of d.columns) {
      const v = fmtVal(row[c]);
      if (v === null || v === '') continue;
      parts.push(`${c}=${v}`);
    }
    L.push(`- ${parts.join('; ')}`);
  }
  L.push('');
  return L.join('\n');
}

const entries = [];
const write = (slug, packed, category, keywords) => {
  for (const p of packed) {
    const file = packed.length > 1 ? `${slug}-${p.part}.md` : `${slug}.md`;
    writeFileSync(join(outDir, file), p.text);
    entries.push({ file, title: p.title, sourceUrl: `${sourceBase}/baza-danych/${dump.database}#dokumentacja/${slug}${packed.length > 1 ? `/${p.part}` : ''}`, category, product: productLabel, part: p.part, parts: p.parts, chars: p.text.length, keywords });
  }
};

// 1) Słowniki — jedna seria dokumentów, tabele alfabetycznie.
const dicts = [...dump.dictionaries].sort((a, b) => a.table.localeCompare(b.table));
const sections = dicts.map((d) => ({ name: d.table, text: renderDictionary(d, docTable(d.table)) }));
write(
  'slowniki-sl',
  packSections(sections, {
    title: `${productLabel} — baza danych: słowniki sl_* (wartości)`,
    intro: `Zawartość tabel słownikowych bazy ${productLabel}: stawki VAT, typy ewidencji VAT, oznaczenia JPK, formy płatności, kategorie dokumentów, kody ZUS i akcyzowe, waluty, kalendarze itd. Każda tabela: opis, kolumny z opisami z dokumentacji producenta, wiersze jako lista „kolumna=wartość". ${PROVENANCE}`,
    maxChars: 80_000,
    keywords: [productLabel, 'słowniki', 'sl_', 'stawki VAT', 'typy ewidencji', 'JPK', 'kody ZUS', ...dicts.slice(0, 10).map((d) => d.table)],
  }),
  'opis tabeli bazy danych',
  ['słowniki'],
);

// 2) CHECK constraints — reguły biznesowe per moduł.
const byModule = new Map();
for (const c of dump.checks ?? []) {
  const m = modulePrefix(c.tableName);
  if (!byModule.has(m)) byModule.set(m, []);
  byModule.get(m).push(c);
}
const checkSections = [...byModule.entries()].sort().map(([m, list]) => ({
  name: `moduł ${m}`,
  text: `### moduł ${m}\n\n${list.map((c) => `- \`${c.tableName}\` / ${c.constraintName}: \`${c.definition}\``).join('\n')}\n\n`,
}));
if (checkSections.length > 0) {
  write(
    'ograniczenia-check',
    packSections(checkSections, {
      title: `${productLabel} — baza danych: ograniczenia CHECK (reguły w tabelach)`,
      intro: `Ograniczenia CHECK zdefiniowane w tabelach bazy ${productLabel} (${dump.checks.length}): warunki, które baza wymusza na wartościach kolumn (dozwolone zakresy, zależności między kolumnami). Pogrupowane po module (prefiks nazwy tabeli). Metadane katalogu, bez danych.`,
      maxChars: 80_000,
      keywords: [productLabel, 'CHECK constraint', 'ograniczenia', 'reguły', 'baza danych'],
    }),
    'opis tabeli bazy danych',
    ['CHECK'],
  );
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ source: `dictionaries ${dump.database}`, entries }, null, 2));
console.log(`słowników: ${dicts.length}, CHECK: ${(dump.checks ?? []).length}, plików: ${entries.length}, znaków: ${entries.reduce((a, e) => a + e.chars, 0)}`);
