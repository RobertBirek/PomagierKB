// CHM (rozpakowany przez `7z x`) → Markdown per rozdział spisu treści (.hhc).
// Kodowanie: pliki InsERT są w windows-1250, a .hhc miesza bajty cp1250 z encjami HTML
// nazywającymi kody Latin-1 (&iquest; = bajt 0xBF = „ż" w cp1250) — dlatego encje są
// rozwiązywane do BAJTÓW przed dekodowaniem cp1250. Czysta logika: parseHhc, htmlToMarkdown,
// planChapters — testowalna na fixture.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import iconv from 'iconv-lite';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const LATIN1_ENTITIES = {
  nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165, brvbar: 166, sect: 167, uml: 168, copy: 169,
  ordf: 170, laquo: 171, not: 172, shy: 173, reg: 174, macr: 175, deg: 176, plusmn: 177, sup2: 178, sup3: 179,
  acute: 180, micro: 181, para: 182, middot: 183, cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188,
  frac12: 189, frac34: 190, iquest: 191, Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197,
  AElig: 198, Ccedil: 199, Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205, Icirc: 206,
  Iuml: 207, ETH: 208, Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214, times: 215,
  Oslash: 216, Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221, THORN: 222, szlig: 223, agrave: 224,
  aacute: 225, acirc: 226, atilde: 227, auml: 228, aring: 229, aelig: 230, ccedil: 231, egrave: 232, eacute: 233,
  ecirc: 234, euml: 235, igrave: 236, iacute: 237, icirc: 238, iuml: 239, eth: 240, ntilde: 241, ograve: 242,
  oacute: 243, ocirc: 244, otilde: 245, ouml: 246, divide: 247, oslash: 248, ugrave: 249, uacute: 250, ucirc: 251,
  uuml: 252, yacute: 253, thorn: 254, yuml: 255, amp: 38, lt: 60, gt: 62, quot: 34,
};

/** Bufor cp1250 z encjami Latin-1 → string UTF-8. */
export function decodeCp1250WithEntities(buf) {
  const latin1 = buf.toString('latin1');
  const resolved = latin1.replace(/&(#(\d+)|#x([0-9a-fA-F]+)|([A-Za-z0-9]+));/g, (m, _all, dec, hex, name) => {
    let code = null;
    if (dec) code = Number(dec);
    else if (hex) code = parseInt(hex, 16);
    else if (name && LATIN1_ENTITIES[name] !== undefined) code = LATIN1_ENTITIES[name];
    if (code === null || code > 255) return m;
    if (code === 38 || code === 60 || code === 62 || code === 34) return m; // &amp; &lt; &gt; &quot; zostają dla parsera
    return String.fromCharCode(code);
  });
  return iconv.decode(Buffer.from(resolved, 'latin1'), 'windows-1250');
}

/** Dekodowanie pliku HTML wg <meta charset> (domyślnie cp1250 dla materiałów InsERT). */
export function decodeHtmlFile(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf.subarray(2), 'utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf.subarray(2), 'utf16be');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const head = buf.subarray(0, 2048).toString('latin1');
  const m = /charset=([A-Za-z0-9_-]+)/i.exec(head);
  const cs = (m?.[1] ?? 'windows-1250').toLowerCase();
  if (cs === 'utf-8' || cs === 'utf8') return buf.toString('utf8');
  return iconv.decode(buf, iconv.encodingExists(cs) ? cs : 'windows-1250');
}

/** .hhc (Sitemap 1.0) → drzewo [{name, local, children}]. */
export function parseHhc(text) {
  const $ = cheerio.load(text);
  const walk = (ul) => {
    const items = [];
    $(ul)
      .children('li')
      .each((_, li) => {
        const obj = $(li).children('object').first();
        const name = obj.find('param[name="Name"]').attr('value') ?? '';
        const local = obj.find('param[name="Local"]').attr('value') ?? null;
        // Zagnieżdżony UL bywa rodzeństwem LI (HTML Help Workshop), nie dzieckiem.
        let childUl = $(li).children('ul').first();
        if (!childUl.length) {
          const next = $(li).next();
          if (next.is('ul')) childUl = next;
        }
        items.push({ name: name.trim(), local, children: childUl.length ? walk(childUl) : [] });
      });
    return items;
  };
  const root = $('body > ul').first();
  return root.length ? walk(root) : [];
}

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
td.remove(['script', 'style', 'noscript', 'iframe', 'object']);

/**
 * Spłaszcza tabele (układ i dane) do akapitów: wiersz → <p>, komórki łączone „ | " gdy ≥2 niepuste.
 * Zagnieżdżone tabele idą od najgłębszych. Tabele markdown i tak byłyby cięte przez chunker.
 */
export function flattenTables($) {
  let tables = $('table').toArray();
  while (tables.length > 0) {
    const inner = tables.filter((t) => $(t).find('table').length === 0);
    for (const t of inner) {
      // Znaczniki „◆" z atrybutem title (np. kolumny produktów w liście zmian) → tekst z title.
      $(t)
        .find('[title]')
        .each((_, el) => {
          const txt = $(el).text().trim();
          if (txt.length <= 2 && $(el).attr('title')) $(el).text($(el).attr('title'));
        });
      const rows = [];
      $(t)
        .find('tr')
        .each((_, tr) => {
          const cells = $(tr)
            .children('td,th')
            .toArray()
            .map((c) => ({ html: ($(c).html() ?? '').replace(/\s+/g, ' ').trim(), text: $(c).text().replace(/\s+/g, ' ').trim() }))
            .filter((c) => c.text !== '');
          if (cells.length === 0) return;
          if (cells.length >= 2) rows.push(`<p>${cells.map((c) => c.html).join(' | ')}</p>`);
          else rows.push(`<div>${cells[0].html}</div>`);
        });
      $(t).replaceWith(`<div>${rows.join('\n')}</div>`);
    }
    tables = $('table').toArray();
  }
}

/** HTML jednej strony → Markdown (bez nagłówka nawigacyjnego, bez obrazków). */
export function htmlToMarkdown(html, { dropSelectors = ['.header', 'nav', '.nav', '#nav', '.footer'] } = {}) {
  const $ = cheerio.load(html);
  for (const sel of dropSelectors) $(sel).remove();
  $('img').remove();
  flattenTables($);
  $('a').each((_, a) => {
    // linki wewnętrzne CHM → sam tekst (zewnętrzne zostają)
    const href = $(a).attr('href') ?? '';
    if (!/^https?:/i.test(href)) $(a).replaceWith($(a).text());
  });
  const title = $('title').first().text().trim();
  const body = $('body').html() ?? '';
  let md = td.turndown(body);
  md = md
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, markdown: md };
}

/**
 * Plan rozdziałów: węzeł 1. poziomu spisu → rozdział ze wszystkimi stronami potomnymi (w kolejności spisu).
 * Gdy rozdział przekracza `descendOver` znaków, schodzi poziom niżej (żeby tytuły części były sensowne);
 * o podział na części ≤ maxChars dba potem packSections. Zwraca [{title, pathTitles, pages:[{name, local}]}].
 */
export function planChapters(tree, sizeOf, maxChars = 80_000, descendOver = maxChars * 4) {
  const out = [];
  const collect = (node) => {
    const pages = [];
    const visit = (n) => {
      if (n.local) pages.push({ name: n.name, local: n.local });
      for (const c of n.children) visit(c);
    };
    visit(node);
    return pages;
  };
  const rec = (node, pathTitles) => {
    const pages = collect(node);
    const size = pages.reduce((a, p) => a + sizeOf(p.local), 0);
    const titles = [...pathTitles, node.name];
    if (size <= descendOver || node.children.length === 0) {
      if (pages.length > 0) out.push({ title: titles.join(' › '), pathTitles: titles, pages });
      return;
    }
    if (node.local) out.push({ title: titles.join(' › '), pathTitles: titles, pages: [{ name: node.name, local: node.local }] });
    // Dzieci: małe grupowane po kolei w rozdziały „A – Z", duże rekurencyjnie.
    let group = [];
    let groupSize = 0;
    const flushGroup = () => {
      if (group.length === 0) return;
      const name = group.length === 1 ? group[0].name : `${group[0].name} – ${group[group.length - 1].name}`;
      const gt = [...titles, name];
      out.push({ title: gt.join(' › '), pathTitles: gt, pages: group.flatMap((g) => g.pages) });
      group = [];
      groupSize = 0;
    };
    for (const c of node.children) {
      const cPages = collect(c);
      const cSize = cPages.reduce((a, p) => a + sizeOf(p.local), 0);
      if (cSize > descendOver) {
        flushGroup();
        rec(c, titles);
        continue;
      }
      if (groupSize + cSize > maxChars * 2 && group.length > 0) flushGroup();
      group.push({ name: c.name, pages: cPages });
      groupSize += cSize;
    }
    flushGroup();
  };
  for (const n of tree) rec(n, []);
  return out;
}

/** Wczytanie rozpakowanego CHM: {tree, pages: Map(localLower → {local, html, sha256})}. */
export function loadChm(dir) {
  const hhcName = readdirRecursive(dir).find((f) => f.toLowerCase().endsWith('.hhc'));
  if (!hhcName) throw new Error(`brak pliku .hhc w ${dir}`);
  const tree = parseHhc(decodeCp1250WithEntities(readFileSync(join(dir, hhcName))));
  const base = dirname(join(dir, hhcName));
  const cache = new Map();
  const getPage = (local) => {
    const key = local.toLowerCase().replace(/^\.?\//, '');
    if (cache.has(key)) return cache.get(key);
    const path = normalize(join(base, local.split('#')[0]));
    let page = null;
    if (existsSync(path)) {
      const buf = readFileSync(path);
      page = { local, html: decodeHtmlFile(buf), sha256: createHash('sha256').update(buf).digest('hex') };
    }
    cache.set(key, page);
    return page;
  };
  return { tree, getPage, base };
}

function readdirRecursive(dir) {

  const out = [];
  const walk = (d, rel) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const r = rel ? `${rel}/${f}` : f;
      if (statSync(p).isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}
