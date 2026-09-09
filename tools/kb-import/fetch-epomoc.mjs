#!/usr/bin/env node
// Crawler e-Pomocy technicznej InsERT (insert.com.pl/dla_uzytkownikow/e-pomoc_techniczna.html):
// listy per program (27 artykułów/strona, parametr offset = numer strony) → artykuły → JSON.
// Grzecznie: 1 żądanie/s, User-Agent z kontaktem, wznawialne (artykuł już w raw/ = pomijany),
// robots.txt serwisu blokuje tylko /wyszukiwanie.html.
// Użycie: node tools/kb-import/fetch-epomoc.mjs --out <katalog> [--programs 1,2,3,4,5,6,7,8] [--delay-ms 1000]

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';

const BASE = 'https://www.insert.com.pl';
const UA =
  'PomagierKB-import/1.0 (+https://kag.ilovelighting.sanok.pl; import dokumentacji do wewnetrznej bazy wiedzy)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, delayMs, attempt = 1) {
  await sleep(delayMs);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    redirect: 'follow',
  });
  if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
    await sleep(delayMs * 10 * attempt);
    return get(url, delayMs, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/** Lista: [{id, slug}] + liczba stron. */
export function parseList(html) {
  const $ = cheerio.load(html);
  const items = new Map();
  $('a[href*="/e-pomoc_techniczna/"]').each((_, a) => {
    const m = /\/e-pomoc_techniczna\/(\d+),([^"?]+)\.html/.exec($(a).attr('href') ?? '');
    if (m) items.set(m[1], { id: Number(m[1]), slug: m[2] });
  });
  let pages = 1;
  $('a[href*="offset="]').each((_, a) => {
    const m = /offset=(\d+)/.exec($(a).attr('href') ?? '');
    if (m) pages = Math.max(pages, Number(m[1]));
  });
  const total = Number((/Znaleziono\s+(\d+)/.exec($('.results-summary').text()) ?? [])[1] ?? 0);
  return { items: [...items.values()], pages, total };
}

/** Artykuł: {id, title, modified, programs, categories, html, text}. */
export function parseArticle(html, id) {
  const $ = cheerio.load(html);
  const head = $('.support-head').first();
  const title = head.find('h1').text().replace(/\s+/g, ' ').trim();
  const modified = head.find('.modification-date-yellow').text().trim() || null;
  const filters = head.find('p.filter-support');
  const programs = [];
  const categories = [];
  filters.each((_, p) => {
    const label = $(p).text().trim();
    const names = $(p)
      .find('a')
      .map((__, a) => $(a).text().trim())
      .get();
    if (/^Program/.test(label)) programs.push(...names);
    else if (/^Kategoria/.test(label)) categories.push(...names);
  });
  const body = $('.support-content').first();
  body.find('script,style').remove();
  return {
    id,
    title,
    modified,
    programs,
    categories,
    html: body.html() ?? '',
    text: body.text().replace(/\s+/g, ' ').trim(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def = null) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const outDir = opt('--out');
  const programs = opt('--programs', '1,2,3,4,5,6,7,8').split(',').map(Number);
  const delayMs = Number(opt('--delay-ms', '1000'));
  if (!outDir) {
    console.error('użycie: fetch-epomoc.mjs --out <katalog> [--programs 1,2,...] [--delay-ms 1000]');
    process.exit(2);
  }
  const rawDir = join(outDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const indexPath = join(outDir, 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { articles: {} };
  const saveIndex = () => writeFileSync(indexPath, JSON.stringify(index, null, 1));

  // 1) Listy per program → zbiór id (artykuł bywa w kilku programach).
  for (const program of programs) {
    const first = parseList(await get(`${BASE}/dla_uzytkownikow/e-pomoc_techniczna.html?program=${program}`, delayMs));
    console.log(`program ${program}: ${first.total} artykułów, ${first.pages} stron`);
    const add = (list) =>
      list.forEach((it) => {
        index.articles[it.id] ??= { id: it.id, slug: it.slug, programs: [] };
        if (!index.articles[it.id].programs.includes(program)) index.articles[it.id].programs.push(program);
      });
    add(first.items);
    for (let page = 2; page <= first.pages; page++) {
      try {
        add(
          parseList(
            await get(`${BASE}/dla_uzytkownikow/e-pomoc_techniczna.html?program=${program}&offset=${page}`, delayMs),
          ).items,
        );
      } catch (err) {
        console.error(`! lista program ${program} strona ${page}: ${err.message}`);
      }
      if (page % 20 === 0) {
        saveIndex();
        console.log(`  strona ${page}/${first.pages}, łącznie id: ${Object.keys(index.articles).length}`);
      }
    }
    saveIndex();
  }
  console.log(`unikalnych artykułów: ${Object.keys(index.articles).length}`);

  // 2) Artykuły (wznawialne).
  const have = new Set(
    readdirSync(rawDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', '')),
  );
  let done = 0;
  let failed = 0;
  const ids = Object.keys(index.articles)
    .map(Number)
    .sort((a, b) => a - b);
  for (const id of ids) {
    if (have.has(String(id))) continue;
    try {
      const html = await get(`${BASE}/dla_uzytkownikow/e-pomoc_techniczna/${id}.html`, delayMs);
      const art = parseArticle(html, id);
      if (!art.title) throw new Error('brak tytułu (inny układ strony?)');
      writeFileSync(join(rawDir, `${id}.json`), JSON.stringify(art));
      done += 1;
      if (done % 50 === 0) console.log(`pobrano ${done} (${have.size + done}/${ids.length})`);
    } catch (err) {
      failed += 1;
      console.error(`! ${id}: ${err.message}`);
    }
  }
  console.log(`gotowe: nowych ${done}, błędów ${failed}, razem ${have.size + done}/${ids.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
