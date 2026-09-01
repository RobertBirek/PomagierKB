import { describe, expect, it } from 'vitest';
import { escapeHtml, renderAnswerHtml, renderMarkdown } from '../src/lib/markdown';

describe('escapeHtml()', () => {
  it('escapuje wszystkie znaki specjalne HTML', () => {
    expect(escapeHtml('<a href="x" onclick=\'y\'>&</a>')).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('renderMarkdown() — XSS', () => {
  it('<script> NIE przechodzi do HTML', () => {
    const html = renderMarkdown('Cześć <script>alert(1)</script> świecie');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('atrybuty zdarzeń i tagi w treści są neutralizowane', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> oraz <iframe src="j">');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<iframe');
    expect(html).not.toMatch(/<[a-z]+ [^>]*onerror/);
  });

  it('markdown w złośliwym payloadzie nadal nie tworzy tagów z wejścia', () => {
    const html = renderMarkdown('**<b>bold</b>**');
    expect(html).toContain('<strong>&lt;b&gt;bold&lt;/b&gt;</strong>');
  });
});

describe('renderMarkdown() — struktura', () => {
  it('nagłówki # → h3 (o dwa poziomy niżej niż w treści)', () => {
    expect(renderMarkdown('# Tytuł')).toBe('<h3>Tytuł</h3>');
    expect(renderMarkdown('## Sekcja')).toBe('<h4>Sekcja</h4>');
  });

  it('pogrubienie i kod inline', () => {
    expect(renderMarkdown('To **ważne** i `kod`')).toBe(
      '<p>To <strong>ważne</strong> i <code>kod</code></p>',
    );
  });

  it('lista nienumerowana i numerowana', () => {
    expect(renderMarkdown('- jeden\n- dwa')).toBe('<ul><li>jeden</li><li>dwa</li></ul>');
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('akapity rozdzielone pustą linią; pojedynczy enter → <br>', () => {
    expect(renderMarkdown('a\n\nb')).toBe('<p>a</p>\n<p>b</p>');
    expect(renderMarkdown('a\nb')).toBe('<p>a<br>b</p>');
  });

  it('CRLF traktowany jak LF', () => {
    expect(renderMarkdown('a\r\n\r\nb')).toBe('<p>a</p>\n<p>b</p>');
  });
});

describe('renderAnswerHtml() — chipy cytowań', () => {
  it('[n] w zakresie → klikalny chip z data-cite', () => {
    const html = renderAnswerHtml('Fakt [1] i fakt [2].', 2);
    expect(html).toContain('<button type="button" class="cite-chip" data-cite="1">[1]</button>');
    expect(html).toContain('data-cite="2"');
  });

  it('[n] poza zakresem zostaje zwykłym tekstem', () => {
    const html = renderAnswerHtml('Fakt [3].', 2);
    expect(html).not.toContain('data-cite="3"');
    expect(html).toContain('[3]');
  });

  it('citeCount=0 → żadnych chipów', () => {
    expect(renderAnswerHtml('Fakt [1].', 0)).not.toContain('data-cite');
  });

  it('złośliwa treść wokół cytowania nadal escapowana', () => {
    const html = renderAnswerHtml('<script>x</script> [1]', 1);
    expect(html).not.toContain('<script');
    expect(html).toContain('data-cite="1"');
  });
});
