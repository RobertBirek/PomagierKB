import { describe, expect, it } from 'vitest';
import {
  extractFences,
  renderFenceHtml,
  renderTables,
  splitTables,
} from '../src/lib/markdownExtras';

describe('extractFences()', () => {
  it('tekst bez fence → jeden segment text', () => {
    expect(extractFences('Zwykły akapit.')).toEqual([
      { kind: 'text', content: 'Zwykły akapit.' },
    ]);
  });

  it('wycina fence z językiem, zachowując kolejność segmentów', () => {
    const segs = extractFences('Przed\n```ts\nconst a = 1;\n```\nPo');
    expect(segs).toEqual([
      { kind: 'text', content: 'Przed' },
      { kind: 'fence', content: 'const a = 1;', lang: 'ts' },
      { kind: 'text', content: 'Po' },
    ]);
  });

  it('fence bez języka → lang pusty', () => {
    const segs = extractFences('```\nx\n```');
    expect(segs).toEqual([{ kind: 'fence', content: 'x', lang: '' }]);
  });

  it('niedomknięty fence → treść do końca tekstu', () => {
    const segs = extractFences('Tekst\n```sh\necho 1');
    expect(segs).toEqual([
      { kind: 'text', content: 'Tekst' },
      { kind: 'fence', content: 'echo 1', lang: 'sh' },
    ]);
  });

  it('markdown w fence NIE jest interpretowany (zostaje surowy)', () => {
    const segs = extractFences('```\n# nagłówek\n**bold**\n```');
    expect(segs[0]).toEqual({ kind: 'fence', content: '# nagłówek\n**bold**', lang: '' });
  });
});

describe('renderFenceHtml() — XSS', () => {
  it('<script> w fence jest escapowany — NIE wykona się', () => {
    const html = renderFenceHtml('<script>alert(1)</script>', '');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.startsWith('<pre><code>')).toBe(true);
  });

  it('język trafia do data-lang (escapowany)', () => {
    const html = renderFenceHtml('x', 'ts"><img onerror=1');
    expect(html).toContain('data-lang="ts&quot;&gt;&lt;img onerror=1"');
    expect(html).not.toContain('"><img');
  });
});

describe('splitTables()', () => {
  it('wykrywa blok tabeli GFM między akapitami', () => {
    const segs = splitTables('Przed\n| A | B |\n|---|---|\n| 1 | 2 |\nPo');
    expect(segs.map((s) => s.kind)).toEqual(['text', 'table', 'text']);
    expect(segs[1]?.content).toBe('| A | B |\n|---|---|\n| 1 | 2 |');
  });

  it('linia z | bez separatora NIE jest tabelą', () => {
    const segs = splitTables('a | b\nzwykły tekst');
    expect(segs).toEqual([{ kind: 'text', content: 'a | b\nzwykły tekst' }]);
  });
});

describe('renderTables()', () => {
  it('renderuje th w thead i td w tbody', () => {
    const html = renderTables('| Nazwa | Ilość |\n|---|---|\n| jabłka | 3 |\n| gruszki | 5 |');
    expect(html).toContain('<thead><tr><th>Nazwa</th><th>Ilość</th></tr></thead>');
    expect(html).toContain('<tr><td>jabłka</td><td>3</td></tr>');
    expect(html).toContain('<tr><td>gruszki</td><td>5</td></tr>');
  });

  it('separator z wyrównaniem (:---:) jest akceptowany i pomijany', () => {
    const html = renderTables('| A | B |\n|:---|---:|\n| 1 | 2 |');
    expect(html).toContain('<th>A</th><th>B</th>');
    expect(html).toContain('<td>1</td><td>2</td>');
  });

  it('XSS w komórkach jest escapowany', () => {
    const html = renderTables('| X |\n|---|\n| <script>alert(1)</script> |');
    expect(html).not.toContain('<script');
    expect(html).toContain('<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>');
  });
});
