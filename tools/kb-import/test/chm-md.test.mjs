import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { decodeCp1250WithEntities, decodeHtmlFile, flattenTables, htmlToMarkdown, parseHhc, planChapters } from '../lib/chm-md.mjs';

describe('chm: kodowanie', () => {
  it('encje Latin-1 w .hhc są bajtami cp1250 (&iquest; → ż, &sup3; → ł, &oacute; → ó)', () => {
    const buf = Buffer.from('Nowo\x9Cci: wa&iquest;ne, p&sup3;atne, og&oacute;lne &amp; &lt;x&gt;', 'latin1');
    expect(decodeCp1250WithEntities(buf)).toBe('Nowości: ważne, płatne, ogólne &amp; &lt;x&gt;');
  });
  it('decodeHtmlFile: BOM UTF-16LE, meta charset cp1250, domyślnie cp1250', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p>żółw</p>', 'utf16le')]);
    expect(decodeHtmlFile(utf16)).toBe('<p>żółw</p>');
    const cp = Buffer.from('<meta charset="windows-1250"><p>\xBF\xF3\xB3w</p>', 'latin1');
    expect(decodeHtmlFile(cp)).toContain('<p>żółw</p>');
    expect(decodeHtmlFile(Buffer.from('<p>\xBF</p>', 'latin1'))).toContain('ż');
  });
});

const HHC = `<HTML><BODY><UL>
<LI><OBJECT type="text/sitemap"><param name="Name" value="Wstęp"><param name="Local" value="htm/intro.htm"></OBJECT>
<LI><OBJECT type="text/sitemap"><param name="Name" value="Pierwsze kroki"></OBJECT>
  <UL>
    <LI><OBJECT type="text/sitemap"><param name="Name" value="Subiekt"><param name="Local" value="htm/a.htm"></OBJECT>
    <LI><OBJECT type="text/sitemap"><param name="Name" value="Rewizor"><param name="Local" value="htm/b.htm"></OBJECT>
  </UL>
<LI><OBJECT type="text/sitemap"><param name="Name" value="Model"><param name="Local" value="htm/m.htm"></OBJECT>
  <UL>
    <LI><OBJECT type="text/sitemap"><param name="Name" value="Obiekty"></OBJECT>
      <UL>
        <LI><OBJECT type="text/sitemap"><param name="Name" value="A"><param name="Local" value="htm/o1.htm"></OBJECT>
        <LI><OBJECT type="text/sitemap"><param name="Name" value="B"><param name="Local" value="htm/o2.htm"></OBJECT>
        <LI><OBJECT type="text/sitemap"><param name="Name" value="C"><param name="Local" value="htm/o3.htm"></OBJECT>
      </UL>
  </UL>
</UL></BODY></HTML>`;

describe('chm: parseHhc + planChapters', () => {
  it('buduje drzewo z zagnieżdżonych UL (także rodzeństwo LI)', () => {
    const tree = parseHhc(HHC);
    expect(tree.map((n) => n.name)).toEqual(['Wstęp', 'Pierwsze kroki', 'Model']);
    expect(tree[1].children.map((n) => n.local)).toEqual(['htm/a.htm', 'htm/b.htm']);
    expect(tree[2].children[0].children.length).toBe(3);
  });
  it('małe rozdziały w całości; duże schodzą poziom niżej i grupują rodzeństwo „A – B"', () => {
    const tree = parseHhc(HHC);
    const size = { 'htm/intro.htm': 10, 'htm/a.htm': 10, 'htm/b.htm': 10, 'htm/m.htm': 10, 'htm/o1.htm': 100, 'htm/o2.htm': 100, 'htm/o3.htm': 100 };
    const plan = planChapters(tree, (l) => size[l] ?? 0, 100, 150);
    expect(plan.map((c) => c.title)).toEqual(['Wstęp', 'Pierwsze kroki', 'Model', 'Model › Obiekty › A – B', 'Model › Obiekty › C']);
    expect(plan[1].pages.map((p) => p.local)).toEqual(['htm/a.htm', 'htm/b.htm']);
  });
});

describe('chm: htmlToMarkdown', () => {
  it('spłaszcza tabele do akapitów, usuwa nagłówek nawigacyjny i obrazki, linki wewnętrzne → tekst', () => {
    const html = `<html><head><title>Obiekt Towar</title></head><body><div class="header">Sfera 1.0</div>
      <h1>Obiekt Towar</h1><p>Zobacz <a href="obiekt2.htm">Obiekt2</a> i <a href="https://insert.com.pl">stronę</a>.</p>
      <img src="x.gif"><table><tr><th>Sub</th><th>Opis</th></tr><tr><td><span title="Subiekt GT">*</span></td><td>Nowy moduł</td></tr><tr><td><br></td><td>Tylko opis</td></tr></table></body></html>`;
    const { title, markdown } = htmlToMarkdown(html);
    expect(title).toBe('Obiekt Towar');
    expect(markdown).toContain('# Obiekt Towar');
    expect(markdown).not.toContain('Sfera 1.0');
    expect(markdown).toContain('Zobacz Obiekt2 i [stronę](https://insert.com.pl).');
    expect(markdown).toContain('Sub | Opis');
    expect(markdown).toContain('Subiekt GT | Nowy moduł');
    expect(markdown).toContain('Tylko opis');
    expect(markdown).not.toContain('<table');
  });
  it('flattenTables radzi sobie z zagnieżdżeniem', () => {
    const $ = cheerio.load('<table><tr><td><table><tr><td>a</td><td>b</td></tr></table></td><td>c</td></tr></table>');
    flattenTables($);
    expect($('table').length).toBe(0);
    expect($.text()).toContain('a | b');
  });
});
