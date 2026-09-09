import { describe, expect, it } from 'vitest';
import { bodyHeight, linesToMarkdown, pageItemsToLines, splitMarkdownSections } from '../lib/pdf-md.mjs';

const item = (str, x, y, h) => ({ str, transform: [1, 0, 0, 1, x, y], height: h });

describe('pdf-md: pageItemsToLines', () => {
  it('grupuje elementy po y, sortuje po x, skleja z rozsądnymi spacjami, punktory → „- "', () => {
    const lines = pageItemsToLines([
      item('Wstęp', 50, 700, 14),
      item('drugi', 120, 500, 9),
      item('pierwszy', 50, 500, 9),
      item(',', 160, 500, 9),
      item('', 50, 480, 9),
      item('punkt', 60, 480, 9),
      item('12', 300, 30, 8),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Wstęp', 'pierwszy drugi,', 'punkt', '12']);
    expect(lines[0].height).toBe(14);
  });
});

describe('pdf-md: linesToMarkdown', () => {
  it('nagłówki po wysokości, numer strony pomijany, dzielenie wyrazów sklejane, akapity łączone', () => {
    const pages = [
      [
        { y: 700, height: 14, text: 'Wstęp' },
        { y: 680, height: 9, text: 'InsERT tworzy pro-' },
        { y: 670, height: 9, text: 'gramy dla firm.' },
        { y: 30, height: 8, text: '5' },
      ],
      [
        { y: 700, height: 11, text: 'Pierwsze kroki' },
        { y: 680, height: 9, text: '- aktywna – działa' },
        { y: 670, height: 9, text: 'w wersji pełnej;' },
        { y: 30, height: 8, text: '6' },
      ],
    ];
    expect(bodyHeight(pages.flat())).toBe(9);
    const md = linesToMarkdown(pages);
    expect(md).toBe('## Wstęp\n\nInsERT tworzy programy dla firm.\n\n### Pierwsze kroki\n\n- aktywna – działa w wersji pełnej;');
  });
  it('splitMarkdownSections dzieli po ## z nazwami', () => {
    const s = splitMarkdownSections('intro\n\n## A\n\ntekst\n\n## B\n\nx');
    expect(s.map((x) => x.name)).toEqual(['wstęp', 'A', 'B']);
    expect(s[1].text).toBe('## A\n\ntekst\n\n');
  });
});
