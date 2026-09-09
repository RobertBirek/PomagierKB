#!/usr/bin/env node
// Crawler forum.insert.com.pl (Invision Community) — sekcje linii GT → wątki → posty.
// Zapisuje wyłącznie treść i ROLĘ autora (grupa: Użytkownik / pracownik InsERT), bez nazwisk
// (docs/data-governance.md — treść publiczna, ale nazwiska użytkowników nie są potrzebne w KB).
// Grzecznie: jedno żądanie na --delay-ms, User-Agent z kontaktem, wznawialne (raw/<id>.json).
// Użycie: node tools/kb-import/fetch-forum.mjs --out <katalog> [--sections 56,57,...] [--delay-ms 700] [--max-topic-pages 4]

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';

const BASE = 'https://forum.insert.com.pl';
const UA = 'PomagierKB-import/1.0 (+https://kag.ilovelighting.sanok.pl; import publicznych watkow do wewnetrznej bazy wiedzy)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sekcje forum linii InsERT GT (id → nazwa). */
export const GT_SECTIONS = {
  55: 'Informacje i aktualności (InsERT GT)',
  56: 'Subiekt GT',
  57: 'Rachmistrz GT',
  58: 'Rewizor GT',
  59: 'Gratyfikant GT',
  60: 'Gestor GT',
  61: 'Biuro GT',
  62: 'Sprawy techniczne (InsERT GT)',
  67: 'mikroGratyfikant GT',
};

async function get(url, delayMs, attempt = 1) {
  await sleep(delayMs);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow' });
  if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
    await sleep(delayMs * 10 * attempt);
    return get(url, delayMs, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/** Lista wątków sekcji: [{id, slug}] + liczba stron („Strona 1 z N"). */
export function parseForumList(html) {
  const $ = cheerio.load(html);
  const topics = new Map();
  $('a[href*="/topic/"]').each((_, a) => {
    const m = /\/topic\/(\d+)-([^/?#"]+)\//.exec($(a).attr('href') ?? '');
    if (m) topics.set(m[1], { id: Number(m[1]), slug: m[2] });
  });
  const pm = /Strona\s+1\s+z\s+(\d+)/i.exec($('.ipsPagination_pageJump').text());
  return { topics: [...topics.values()], pages: pm ? Number(pm[1]) : 1 };
}

/** Strona wątku: tytuł, liczba stron, posty [{role, time, html, text}]. */
export function parseTopicPage(html) {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const pm = /Strona\s+\d+\s+z\s+(\d+)/i.exec($('.ipsPagination_pageJump').first().text());
  const pages = pm ? Number(pm[1]) : 1;
  const posts = [];
  $('article.cPost').each((_, art) => {
    const $a = $(art);
    // Grupa: tekst („Użytkownik") albo ikona grupy (pracownicy InsERT mają obrazek grupa_insert.png).
    const groupLi = $a.find('.cAuthorPane_info li').first();
    const group = `${groupLi.text()} ${groupLi.find('img').attr('src') ?? ''} ${groupLi.find('img').attr('alt') ?? ''}`.replace(/\s+/g, ' ').trim();
    const role = /grupa_insert|insert|pracownik|moderator|administrator/i.test(group) ? 'InsERT' : 'użytkownik';
    const time = $a.find('time').first().attr('datetime') ?? null;
    const content = $a.find('[data-role="commentContent"]').first();
    content.find('blockquote, script, style, .ipsQuote, .ipsEmbeddedVideo, img').remove();
    const html = content.html() ?? '';
    const text = content.text().replace(/\s+/g, ' ').trim();
    if (text !== '') posts.push({ role, time, html, text });
  });
  const solved = $('.ipsComment_solved, [data-role="solvedBadge"], .cTopicSolved').length > 0;
  return { title, pages, posts, solved };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def = null) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const outDir = opt('--out');
  const sections = opt('--sections', Object.keys(GT_SECTIONS).join(',')).split(',').map(Number);
  const delayMs = Number(opt('--delay-ms', '700'));
  const maxTopicPages = Number(opt('--max-topic-pages', '4'));
  if (!outDir) {
    console.error('użycie: fetch-forum.mjs --out <katalog> [--sections 56,57] [--delay-ms 700] [--max-topic-pages 4]');
    process.exit(2);
  }
  const rawDir = join(outDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const indexPath = join(outDir, 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { topics: {}, listsDone: {} };
  const saveIndex = () => writeFileSync(indexPath, JSON.stringify(index, null, 1));

  for (const section of sections) {
    if (index.listsDone[section]) continue;
    const first = parseForumList(await get(`${BASE}/index.php?/forum/${section}-x/`, delayMs));
    console.log(`sekcja ${section} (${GT_SECTIONS[section] ?? '?'}): ${first.pages} stron`);
    const add = (list) => list.forEach((t) => { index.topics[t.id] ??= { id: t.id, slug: t.slug, section }; });
    add(first.topics);
    for (let page = 2; page <= first.pages; page++) {
      try {
        add(parseForumList(await get(`${BASE}/index.php?/forum/${section}-x/page/${page}/`, delayMs)).topics);
      } catch (err) {
        console.error(`! lista ${section}/${page}: ${err.message}`);
      }
      if (page % 25 === 0) {
        saveIndex();
        console.log(`  strona ${page}/${first.pages}, wątków: ${Object.keys(index.topics).length}`);
      }
    }
    index.listsDone[section] = true;
    saveIndex();
  }
  console.log(`wątków łącznie: ${Object.keys(index.topics).length}`);

  const have = new Set(readdirSync(rawDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')));
  let done = 0;
  let failed = 0;
  const ids = Object.keys(index.topics).map(Number).sort((a, b) => a - b);
  for (const id of ids) {
    if (have.has(String(id))) continue;
    const meta = index.topics[id];
    try {
      const url = `${BASE}/index.php?/topic/${id}-${meta.slug}/`;
      const first = parseTopicPage(await get(url, delayMs));
      const posts = [...first.posts];
      const pagesToFetch = Math.min(first.pages, maxTopicPages);
      for (let p = 2; p <= pagesToFetch; p++) posts.push(...parseTopicPage(await get(`${url}page/${p}/`, delayMs)).posts);
      writeFileSync(join(rawDir, `${id}.json`), JSON.stringify({ id, url, title: first.title, section: meta.section, sectionName: GT_SECTIONS[meta.section] ?? String(meta.section), pages: first.pages, fetchedPages: pagesToFetch, solved: first.solved, posts }));
      done += 1;
      if (done % 100 === 0) console.log(`pobrano ${done} (${have.size + done}/${ids.length})`);
    } catch (err) {
      failed += 1;
      console.error(`! ${id}: ${err.message}`);
    }
  }
  console.log(`gotowe: nowych ${done}, błędów ${failed}, razem ${have.size + done}/${ids.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
