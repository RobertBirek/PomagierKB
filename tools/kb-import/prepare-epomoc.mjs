#!/usr/bin/env node
// Artykuły e-Pomocy (fetch-epomoc.mjs → raw/*.json) → fragmenty Markdown pogrupowane po programie
// i kategorii (≤80 000 zn.), każdy artykuł jako sekcja H2 z datą modyfikacji i adresem źródłowym.
// Użycie: node tools/kb-import/prepare-epomoc.mjs --in <katalog epomoc> --out <out/epomoc>
// Artykuł z wieloma programami trafia do grupy pierwszego produktu GT z listy (albo „InsERT GT").

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packSections } from './lib/catalog-md.mjs';
import { htmlToMarkdown } from './lib/chm-md.mjs';
import { slugify } from './lib/sources.mjs';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const inDir = opt('--in');
const outDir = opt('--out');
if (!inDir || !outDir) {
  console.error('użycie: prepare-epomoc.mjs --in <katalog epomoc> --out <katalog>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const MAX = 80_000;
const PRODUCT_ORDER = ['Subiekt GT', 'Rewizor GT', 'Rachmistrz GT', 'Gratyfikant GT', 'mikroGratyfikant GT', 'Gestor GT', 'Biuro GT', 'InsERT GT'];
const PROVENANCE = 'Właściciel treści: InsERT S.A.; źródło: e-Pomoc techniczna (insert.com.pl), artykuły publiczne; użytek wewnętrzny.';

/** Produkt grupujący: pierwszy z PRODUCT_ORDER obecny w liście programów artykułu. */
export function groupProduct(programs) {
  return PRODUCT_ORDER.find((p) => programs.includes(p)) ?? 'InsERT GT';
}

const rawDir = join(inDir, 'raw');
const articles = readdirSync(rawDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(rawDir, f), 'utf8')))
  .filter((a) => a.title && a.text && a.text.length >= 40);
console.log(`artykułów: ${articles.length}`);

const groups = new Map(); // `${product}|${category}` → [article]
for (const a of articles) {
  const product = groupProduct(a.programs ?? []);
  const category = a.categories?.[0] ?? 'Inne';
  const key = `${product}|${category}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(a);
}

const entries = [];
for (const [key, list] of [...groups.entries()].sort()) {
  const [product, category] = key.split('|');
  list.sort((a, b) => a.title.localeCompare(b.title, 'pl'));
  const sections = list.map((a) => {
    const url = `https://www.insert.com.pl/dla_uzytkownikow/e-pomoc_techniczna/${a.id}.html`;
    const md = htmlToMarkdown(`<html><body>${a.html}</body></html>`).markdown.replace(/^#(#{0,4}) /gm, '###$1 ');
    const meta = [a.modified ? `Ostatnia modyfikacja: ${a.modified}` : null, a.programs?.length ? `Programy: ${a.programs.join(', ')}` : null, a.categories?.length ? `Kategoria: ${a.categories.join(', ')}` : null, `Źródło: ${url}`].filter(Boolean).join('. ');
    return { name: a.title, text: `## ${a.title}\n\n${meta}.\n\n${md}\n\n` };
  });
  const slug = `epomoc-${slugify(product)}-${slugify(category)}`;
  const title = `e-Pomoc InsERT — ${product} — ${category}`;
  const intro = `Odpowiedzi e-Pomocy technicznej InsERT dla programu ${product}, kategoria „${category}" (${list.length} artykułów: pytanie → procedura krok po kroku, z datą ostatniej modyfikacji). Wersja programu: 1.89. ${PROVENANCE}`;
  const keywords = ['InsERT GT', product, category, 'e-Pomoc', 'FAQ', ...list.slice(0, 8).map((a) => a.title.replace(/^[^–-]+[–-]\s*/, '').slice(0, 60))];
  const packed = packSections(sections, { title, intro, maxChars: MAX, keywords });
  for (const p of packed) {
    const file = packed.length > 1 ? `${slug}-${p.part}.md` : `${slug}.md`;
    writeFileSync(join(outDir, file), p.text);
    entries.push({
      file,
      title: p.title,
      sourceUrl: `https://www.insert.com.pl/dla_uzytkownikow/e-pomoc_techniczna.html#dokumentacja/${slug}${packed.length > 1 ? `/${p.part}` : ''}`,
      category: 'FAQ e-Pomoc',
      product,
      part: p.part,
      parts: p.parts,
      chars: p.text.length,
      keywords,
      sourceFile: 'e-pomoc_techniczna',
      articles: p.names.length,
    });
  }
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ source: 'https://www.insert.com.pl/dla_uzytkownikow/e-pomoc_techniczna.html', generatedAt: new Date().toISOString(), entries, skipped: [] }, null, 2));
const total = entries.reduce((a, e) => a + e.chars, 0);
console.log(`grup: ${groups.size}, plików: ${entries.length}, znaków: ${total}`);
