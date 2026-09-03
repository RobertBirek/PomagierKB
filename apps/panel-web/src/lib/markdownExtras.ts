/**
 * Nadbudowa nad lib/markdown (NIETYKALNY): obsługa code-fence ``` i tabel GFM.
 * Czyste funkcje bez Reacta — testowane w test/markdownExtras.test.ts.
 *
 * Strategia XSS: wszystko co generujemy TU (poza renderMarkdown/renderAnswerHtml)
 * przechodzi przez escapeHtml z lib/markdown — <script> w fence ani w komórce
 * tabeli nigdy nie trafia do DOM jako tag.
 */
import { escapeHtml } from './markdown';

export type MdSegment =
  | { kind: 'text'; content: string }
  | { kind: 'fence'; content: string; lang: string }
  | { kind: 'table'; content: string };

/**
 * Wycina bloki ``` z markdownu ZANIM tekst trafi do lib/markdown.
 * Zwraca segmenty w kolejności wystąpienia: 'text' (dla lib) i 'fence'
 * (surowa treść bloku + język z linii otwierającej). Niedomknięty fence
 * jest traktowany jako fence do końca tekstu.
 */
export function extractFences(text: string): MdSegment[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const segments: MdSegment[] = [];
  let buf: string[] = [];
  let fence: { lang: string; lines: string[] } | null = null;

  const flushText = (): void => {
    if (buf.length > 0) {
      segments.push({ kind: 'text', content: buf.join('\n') });
      buf = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (fence === null) {
      if (trimmed.startsWith('```')) {
        flushText();
        fence = { lang: trimmed.slice(3).trim(), lines: [] };
      } else {
        buf.push(line);
      }
    } else if (trimmed === '```') {
      segments.push({ kind: 'fence', content: fence.lines.join('\n'), lang: fence.lang });
      fence = null;
    } else {
      fence.lines.push(line);
    }
  }
  if (fence !== null) {
    segments.push({ kind: 'fence', content: fence.lines.join('\n'), lang: fence.lang });
  }
  flushText();
  return segments;
}

/** Linia separatora GFM: | --- | :---: | (co najmniej jeden myślnik i pipe). */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return t.includes('-') && t.includes('|') && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
}

/**
 * Dzieli segment tekstowy na 'text' i 'table' (blok GFM: wiersz nagłówka
 * z |, separator |---|, wiersze z | do pierwszej linii bez |).
 */
export function splitTables(text: string): MdSegment[] {
  const lines = text.split('\n');
  const segments: MdSegment[] = [];
  let buf: string[] = [];

  const flushText = (): void => {
    if (buf.length > 0) {
      segments.push({ kind: 'text', content: buf.join('\n') });
      buf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && isTableSeparator(next)) {
      flushText();
      const tableLines = [line, next];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|')) {
        tableLines.push(lines[i] ?? '');
        i += 1;
      }
      segments.push({ kind: 'table', content: tableLines.join('\n') });
    } else {
      buf.push(line);
      i += 1;
    }
  }
  flushText();
  return segments;
}

/** Wiersz tabeli → komórki (bez skrajnych pustych od | na brzegach), ESCAPOWANE. */
function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((cell) => escapeHtml(cell.trim()));
}

/**
 * JEDEN blok tabeli GFM (markdown) → HTML <table> z escapowanymi komórkami.
 * Wiersz 1 = nagłówek (th), wiersz 2 = separator (pomijany), reszta = td.
 */
export function renderTables(tableMd: string): string {
  const lines = tableMd.split('\n').filter((l) => l.trim() !== '');
  const header = parseRow(lines[0] ?? '');
  const body = lines.slice(2).map(parseRow);
  const thead = `<thead><tr>${header.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
  const rows = body
    .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table>${thead}<tbody>${rows}</tbody></table>`;
}

/** Blok fence → <pre><code> z CAŁĄ treścią escapowaną (XSS-safe). */
export function renderFenceHtml(code: string, lang: string): string {
  const langAttr = lang !== '' ? ` data-lang="${escapeHtml(lang)}"` : '';
  return `<pre><code${langAttr}>${escapeHtml(code)}</code></pre>`;
}
