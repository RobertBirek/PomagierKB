import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chunkDocument, isPseudoHeading, makePreview } from '../src/pipeline/chunker.js';

/**
 * Testy WŁAŚCIWOŚCI chunkera (Etap 6): żaden chunk > maxLen; konkatenacja
 * chunków == tekst modulo whitespace; determinizm; nagłówki (markdown #–###
 * i pseudo-nagłówki ALL-CAPS) trafiają do sectionHeading.
 */

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Normalizacja "modulo whitespace" — do porównania rekonstrukcji. */
const squash = (s: string): string => s.replace(/\s+/g, '');

function sentence(i: number): string {
  return `To jest zdanie numer ${i} o systemach oświetlenia awaryjnego w budynkach użyteczności publicznej.`;
}

function longParagraph(sentences: number): string {
  return Array.from({ length: sentences }, (_, i) => sentence(i)).join(' ');
}

const SAMPLE = [
  'Wstęp przed pierwszym nagłówkiem — krótki akapit.',
  '',
  '# Oświetlenie awaryjne',
  '',
  'Pierwszy akapit sekcji o oświetleniu.',
  '',
  longParagraph(60), // ~6k znaków — wymusi podział na granicy zdań
  '',
  '## Normy i przepisy',
  '',
  'Akapit o normie PN-EN 1838.',
  '',
  'ROZDZIAL 4 WYMAGANIA TECHNICZNE', // pseudo-nagłówek ALL-CAPS (OCR)
  '',
  'Treść rozdziału czwartego po pseudo-nagłówku.',
  '',
  '### Podsekcja szczegółowa',
  'Treść podsekcji.',
  '',
  '#### Nagłówek poziomu 4 zostaje treścią',
  'Akapit pod nagłówkiem H4.',
].join('\n');

describe('chunkDocument — właściwości', () => {
  it('żaden chunk nie przekracza maxLen (domyślne 1800 i customowe 200)', () => {
    for (const maxLen of [1800, 200]) {
      const chunks = chunkDocument(SAMPLE, { maxLen });
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.content.length, `chunk #${c.sectionOrder} przekracza ${maxLen}`).toBeLessThanOrEqual(maxLen);
        expect(c.contentLength).toBe(c.content.length);
      }
    }
  });

  it('konkatenacja chunków == tekst wejściowy modulo whitespace', () => {
    for (const maxLen of [1800, 300]) {
      const chunks = chunkDocument(SAMPLE, { maxLen });
      expect(squash(chunks.map((c) => c.content).join(''))).toBe(squash(SAMPLE));
    }
  });

  it('determinizm: dwa wywołania dają identyczny wynik', () => {
    expect(chunkDocument(SAMPLE)).toEqual(chunkDocument(SAMPLE));
    expect(chunkDocument(SAMPLE, { maxLen: 250, previewLen: 100 })).toEqual(
      chunkDocument(SAMPLE, { maxLen: 250, previewLen: 100 }),
    );
  });

  it('nagłówki #–### i pseudo-nagłówki ALL-CAPS trafiają do sectionHeading', () => {
    const chunks = chunkDocument(SAMPLE);
    const headings = new Set(chunks.map((c) => c.sectionHeading));
    expect(headings).toContain(''); // preambuła przed pierwszym nagłówkiem
    expect(headings).toContain('Oświetlenie awaryjne');
    expect(headings).toContain('Normy i przepisy');
    expect(headings).toContain('ROZDZIAL 4 WYMAGANIA TECHNICZNE');
    expect(headings).toContain('Podsekcja szczegółowa');
    // H4 NIE jest nagłówkiem sekcji (spec: tylko #–###) — zostaje treścią.
    expect(headings).not.toContain('Nagłówek poziomu 4 zostaje treścią');
    const h4Chunk = chunks.find((c) => c.content.includes('#### Nagłówek poziomu 4'));
    expect(h4Chunk?.sectionHeading).toBe('Podsekcja szczegółowa');
  });

  it('sectionOrder to globalny licznik 0..n-1; hash i preview spójne z treścią', () => {
    const chunks = chunkDocument(SAMPLE, { maxLen: 400, previewLen: 120 });
    chunks.forEach((c, i) => {
      expect(c.sectionOrder).toBe(i);
      expect(c.contentHash).toBe(sha256(c.content));
      expect(c.contentPreview.length).toBeLessThanOrEqual(120);
      expect(c.content.startsWith(c.contentPreview)).toBe(true);
      if (c.contentPreview.length < c.content.length) {
        // Cięcie na granicy słowa: znak tuż za preview w treści to whitespace.
        expect(/\s/.test(c.content.charAt(c.contentPreview.length))).toBe(true);
      }
    });
  });

  it('akapit dłuższy niż maxLen dzielony na granicy zdania, megasłowo — twardo', () => {
    const para = longParagraph(40);
    const chunks = chunkDocument(para, { maxLen: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) {
      expect(c.content.endsWith('.')).toBe(true); // cięcie po zdaniu
    }
    const megaword = 'x'.repeat(4_000);
    const hard = chunkDocument(megaword, { maxLen: 1000 });
    expect(hard.map((c) => c.content.length)).toEqual([1000, 1000, 1000, 1000]);
    expect(squash(hard.map((c) => c.content).join(''))).toBe(megaword);
  });

  it('pusty/whitespace dokument → brak chunków', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('  \n\n \t\n')).toEqual([]);
  });
});

describe('pomocniki chunkera', () => {
  it('isPseudoHeading: ALL-CAPS ≤80 z ≥3 literami; odrzuca małe litery, cyfry i długie linie', () => {
    expect(isPseudoHeading('ROZDZIAL PIERWSZY')).toBe(true);
    expect(isPseudoHeading('WYMAGANIA TECHNICZNE 2024')).toBe(true);
    expect(isPseudoHeading('Rozdzial pierwszy')).toBe(false);
    expect(isPseudoHeading('1800')).toBe(false);
    expect(isPseudoHeading('AB')).toBe(false);
    expect(isPseudoHeading('A'.repeat(81))).toBe(false);
  });

  it('makePreview: prefix treści ≤limit, ucięty na granicy słowa', () => {
    const text = 'jeden dwa trzy cztery pięć sześć';
    expect(makePreview(text, 100)).toBe(text);
    const cut = makePreview(text, 12);
    expect(cut).toBe('jeden dwa');
    expect(makePreview('x'.repeat(50), 10)).toBe('x'.repeat(10)); // megasłowo — twardo
  });
});

describe('chunker — świadomość code-fence (Faza 4 programu rozbudowy)', () => {
  it('blok ``` z pustymi liniami w środku pozostaje jednym kawałkiem', () => {
    const md = [
      '# Instrukcja',
      'Akapit wstępny.',
      '',
      '```bash',
      'echo start',
      '',
      'echo po pustej linii',
      '```',
      '',
      'Akapit końcowy.',
    ].join('\n');
    const chunks = chunkDocument(md, { maxLen: 1800 });
    const joined = chunks.map((c) => c.content).join('\n\n');
    // fence w całości w jednym chunku: otwarcie i domknięcie w tym samym kawałku
    const withFence = chunks.filter((c) => c.content.includes('```'));
    expect(withFence).toHaveLength(1);
    expect((withFence[0]!.content.match(/```/g) ?? []).length).toBe(2);
    expect(withFence[0]!.content).toContain('echo po pustej linii');
    expect(joined).toContain('Akapit wstępny.');
    expect(joined).toContain('Akapit końcowy.');
  });

  it('fence dłuższy niż maxLen dzielony na granicach linii z ponownym otwarciem', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `linia_kodu_${i} = wartość_${i};`);
    const md = '```js\n' + lines.join('\n') + '\n```';
    const chunks = chunkDocument(md, { maxLen: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(400);
      expect(c.content.startsWith('```js\n')).toBe(true);
      expect(c.content.endsWith('\n```')).toBe(true);
    }
    // żadna linia kodu nie zginęła
    const all = chunks.map((c) => c.content).join('\n');
    for (const l of lines) expect(all).toContain(l);
  });

  it('fence niedomknięty (urwany dokument) nie wywraca chunkera', () => {
    const md = 'Tekst.\n\n```python\nprint("bez domknięcia")';
    const chunks = chunkDocument(md, { maxLen: 1800 });
    expect(chunks.map((c) => c.content).join('\n')).toContain('print("bez domknięcia")');
  });
});
