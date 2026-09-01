import { createHash } from 'node:crypto';

/**
 * CHUNKER (Etap 6, docs/design/pipeline-frontend.md) — CZYSTA funkcja bez
 * frameworka i bez IO. Algorytm: podział na sekcje po nagłówkach markdown
 * `#`–`###` (oraz linie ALL-CAPS ≤80 znaków jako pseudo-nagłówki dla tekstu
 * z OCR), w sekcji akapity pakowane zachłannie do ≤maxLen (1800), akapit
 * dłuższy dzielony na granicy zdania ('. ' najbliżej limitu), w ostateczności
 * twardo co maxLen. BEZ overlapu (id deterministyczne → idempotentny UPSERT).
 *
 * Właściwości gwarantowane (testy pipeline-build-chunker.test.ts):
 * - żaden chunk nie przekracza maxLen;
 * - konkatenacja chunków == tekst wejściowy modulo whitespace (linie nagłówków
 *   ZOSTAJĄ w treści chunków — sectionHeading to metadana, nie wycięcie);
 * - determinizm (czysta funkcja bez losowości i zegara).
 */

export interface ChunkerOptions {
  /** Twardy limit długości chunka (pole indeksowane TextAndVector) — domyślnie 1800. */
  maxLen?: number;
  /** Limit contentPreview (cięcie na granicy słowa) — domyślnie 800. */
  previewLen?: number;
}

export interface DocumentChunk {
  content: string;
  /** Nagłówek sekcji, z której pochodzi chunk ('' dla tekstu przed pierwszym nagłówkiem). */
  sectionHeading: string;
  /** Globalny licznik chunków w dokumencie (0-based, rosnący). */
  sectionOrder: number;
  /** Pierwsze ≤previewLen znaków content ucięte na granicy słowa. */
  contentPreview: string;
  /** sha256(content) hex. */
  contentHash: string;
  contentLength: number;
}

const DEFAULT_MAX_LEN = 1800;
const DEFAULT_PREVIEW_LEN = 800;

/** Nagłówek markdown poziomu 1-3: '# Tytuł' / '## Tytuł ##'. */
const MD_HEADING_RE = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

/**
 * Pseudo-nagłówek z OCR: linia ALL-CAPS 3–80 znaków, ≥3 wielkie litery,
 * ZERO małych liter (cyfry/interpunkcja dozwolone).
 */
export function isPseudoHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 80) return false;
  if (/\p{Ll}/u.test(t)) return false;
  const upper = t.match(/\p{Lu}/gu);
  return upper !== null && upper.length >= 3;
}

interface Section {
  heading: string;
  lines: string[];
}

/** Podział dokumentu na sekcje; linia nagłówka zostaje w treści sekcji. */
function splitSections(markdown: string): Section[] {
  const sections: Section[] = [{ heading: '', lines: [] }];
  for (const line of markdown.split('\n')) {
    const md = MD_HEADING_RE.exec(line);
    const heading = md !== null ? md[2]!.trim() : isPseudoHeading(line) ? line.trim() : null;
    if (heading !== null) {
      sections.push({ heading, lines: [line] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }
  return sections.filter((s) => s.lines.some((l) => l.trim() !== ''));
}

/** Akapit dłuższy niż maxLen: cięcie na granicy zdania ('. '), twardo w ostateczności. */
function splitLongParagraph(text: string, maxLen: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    const sentenceEnd = window.lastIndexOf('. ');
    const end = sentenceEnd > 0 ? sentenceEnd + 1 : maxLen; // po kropce; bez zdania — twardo
    out.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest !== '') out.push(rest);
  return out;
}

/** Pierwsze ≤previewLen znaków ucięte na granicy słowa (prefix content). */
export function makePreview(content: string, previewLen: number = DEFAULT_PREVIEW_LEN): string {
  if (content.length <= previewLen) return content;
  const head = content.slice(0, previewLen);
  if (/\s/.test(content.charAt(previewLen))) return head.trimEnd();
  for (let i = head.length - 1; i >= 0; i--) {
    if (/\s/.test(head.charAt(i))) return head.slice(0, i).trimEnd();
  }
  return head; // jedno „megasłowo" dłuższe niż limit — twarde cięcie
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function chunkDocument(markdown: string, options: ChunkerOptions = {}): DocumentChunk[] {
  const maxLen = Math.max(1, options.maxLen ?? DEFAULT_MAX_LEN);
  const previewLen = Math.max(1, options.previewLen ?? DEFAULT_PREVIEW_LEN);

  const chunks: DocumentChunk[] = [];
  let order = 0;

  const push = (content: string, heading: string): void => {
    const trimmed = content.trim();
    if (trimmed === '') return;
    chunks.push({
      content: trimmed,
      sectionHeading: heading,
      sectionOrder: order++,
      contentPreview: makePreview(trimmed, previewLen),
      contentHash: sha256hex(trimmed),
      contentLength: trimmed.length,
    });
  };

  for (const section of splitSections(markdown)) {
    // Akapity sekcji (split po pustej linii), za długie dzielone od razu na kawałki ≤maxLen.
    const pieces: string[] = [];
    for (const para of section.lines.join('\n').split(/\n\s*\n/)) {
      const p = para.trim();
      if (p === '') continue;
      if (p.length <= maxLen) pieces.push(p);
      else pieces.push(...splitLongParagraph(p, maxLen));
    }

    // Zachłanne pakowanie kawałków do limitu (separator '\n\n' liczy się do długości).
    let current = '';
    for (const piece of pieces) {
      const candidate = current === '' ? piece : `${current}\n\n${piece}`;
      if (candidate.length <= maxLen) {
        current = candidate;
      } else {
        push(current, section.heading);
        current = piece;
      }
    }
    push(current, section.heading);
  }

  return chunks;
}
