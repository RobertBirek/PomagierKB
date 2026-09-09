#!/usr/bin/env node
// Wątki forum (fetch-forum.mjs → raw/*.json) → fragmenty Markdown pogrupowane po sekcji i roku (≤80 000 zn.).
// Każdy wątek = sekcja H2: pytanie (pierwszy post) + odpowiedzi z rolą autora (InsERT / użytkownik) i datą.
// Wątki bez odpowiedzi i bardzo krótkie są pomijane (szum). Limity: 1. post ≤4 000 zn., odpowiedź ≤1 500,
// ≤12 odpowiedzi, wątek ≤12 000 zn. — odpowiedzi pracowników InsERT mają pierwszeństwo.
// Użycie: node tools/kb-import/prepare-forum.mjs --in <katalog forum> --out <out/forum>

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packSections } from './lib/catalog-md.mjs';
import { htmlToMarkdown } from './lib/chm-md.mjs';
import { slugify } from './lib/sources.mjs';

const MAX = 80_000;
const FIRST_MAX = 4000;
const REPLY_MAX = 1500;
const MAX_REPLIES = 12;
const TOPIC_MAX = 12_000;
const PROVENANCE =
  'Źródło: forum.insert.com.pl (publiczne wątki użytkowników i pracowników InsERT; treść społeczności, nie oficjalna dokumentacja — weryfikuj z e-Pomocą). Nazwiska autorów pominięte; podana jest rola (InsERT / użytkownik).';

const cut = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + ' (…)' : s);
const dateOf = (iso) => (iso ? String(iso).slice(0, 10) : '');
const toMd = (html) =>
  htmlToMarkdown(`<html><body>${html}</body></html>`)
    .markdown.replace(/^#{1,6} /gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Wątek → sekcja markdown albo null (szum). */
export function renderTopic(t) {
  const posts = (t.posts ?? []).filter((p) => p.text && p.text.length >= 15);
  if (posts.length < 2) return null;
  const [first, ...rest] = posts;
  // Odpowiedzi: pracownicy InsERT najpierw (zachowując kolejność), potem użytkownicy — do limitu.
  const staff = rest.filter((p) => p.role === 'InsERT');
  const others = rest.filter((p) => p.role !== 'InsERT');
  const chosen = [...staff, ...others]
    .slice(0, MAX_REPLIES)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const lines = [];
  lines.push(`## ${t.title}`);
  lines.push('');
  lines.push(
    `Sekcja: ${t.sectionName}. Data: ${dateOf(first.time)}. Odpowiedzi: ${rest.length}${t.solved ? ' (wątek rozwiązany)' : ''}. Adres: ${t.url}`,
  );
  lines.push('');
  lines.push(`**Pytanie (${first.role}, ${dateOf(first.time)}):** ${cut(toMd(first.html), FIRST_MAX)}`);
  lines.push('');
  let total = lines.join('\n').length;
  for (const p of chosen) {
    const body = cut(toMd(p.html), REPLY_MAX);
    const line = `**Odpowiedź (${p.role}, ${dateOf(p.time)}):** ${body}`;
    if (total + line.length > TOPIC_MAX) break;
    lines.push(line, '');
    total += line.length + 2;
  }
  return {
    name: t.title,
    text: lines.join('\n') + '\n\n',
    year: dateOf(first.time).slice(0, 4) || 'brak',
    hasStaff: staff.length > 0,
  };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, def = null) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const inDir = opt('--in');
  const outDir = opt('--out');
  if (!inDir || !outDir) {
    console.error('użycie: prepare-forum.mjs --in <katalog forum> --out <katalog>');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const rawDir = join(inDir, 'raw');
  const topics = readdirSync(rawDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(rawDir, f), 'utf8')));
  console.log(`wątków: ${topics.length}`);

  const groups = new Map(); // `${sectionName}|${year}` → sections[]
  let kept = 0;
  let skipped = 0;
  let withStaff = 0;
  for (const t of topics) {
    const r = renderTopic(t);
    if (!r) {
      skipped += 1;
      continue;
    }
    kept += 1;
    if (r.hasStaff) withStaff += 1;
    const key = `${t.sectionName}|${r.year}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  console.log(
    `zachowane: ${kept} (z odpowiedzią InsERT: ${withStaff}), pominięte (bez odpowiedzi/krótkie): ${skipped}`,
  );

  const entries = [];
  for (const [key, list] of [...groups.entries()].sort()) {
    const [sectionName, year] = key.split('|');
    list.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    const slug = `forum-${slugify(sectionName)}-${year}`;
    const title = `Forum InsERT — ${sectionName} — wątki ${year}`;
    const intro = `Wątki forum InsERT z sekcji „${sectionName}" z roku ${year} (${list.length} wątków: pytanie użytkownika i odpowiedzi, w tym pracowników InsERT). ${PROVENANCE}`;
    const keywords = ['InsERT GT', sectionName, 'forum', year, ...list.slice(0, 8).map((s) => s.name.slice(0, 60))];
    const packed = packSections(list, { title, intro, maxChars: MAX, keywords });
    for (const p of packed) {
      const file = packed.length > 1 ? `${slug}-${p.part}.md` : `${slug}.md`;
      writeFileSync(join(outDir, file), p.text);
      entries.push({
        file,
        title: p.title,
        sourceUrl: `https://forum.insert.com.pl/#dokumentacja/${slug}${packed.length > 1 ? `/${p.part}` : ''}`,
        category: 'forum użytkowników',
        product: sectionName.replace(/ \(.*\)$/, ''),
        part: p.part,
        parts: p.parts,
        chars: p.text.length,
        keywords,
        sourceFile: 'forum.insert.com.pl',
        topics: p.names.length,
      });
    }
  }
  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify(
      { source: 'https://forum.insert.com.pl/', generatedAt: new Date().toISOString(), entries, skipped: [] },
      null,
      2,
    ),
  );
  console.log(`grup: ${groups.size}, plików: ${entries.length}, znaków: ${entries.reduce((a, e) => a + e.chars, 0)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
