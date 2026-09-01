/**
 * Minimalny renderer markdown dla odpowiedzi /ask — BEZ zależności zewnętrznych.
 * Obsługuje: nagłówki #–####, pogrubienie **x**, kod `x`, listy (myślnik,
 * gwiazdka, numerowane) i akapity.
 * XSS-safe: CAŁE wejście jest escapowane PRZED transformacją (test w
 * test/markdown.test.ts pilnuje, że <script> nie przechodzi).
 * Cytowania [n] zamieniane na klikalne chipy <button data-cite="n"> — obsługa
 * kliknięć przez delegację w AskPage (czysta funkcja nie zna Reacta).
 */

/** Escapowanie HTML — pierwszy krok KAŻDEJ transformacji (kolejność ma znaczenie). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Transformacje inline na JUŻ escapowanym tekście: **bold**, `code`. */
function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

interface Block {
  kind: 'heading' | 'ul' | 'ol' | 'p';
  level?: number;
  lines: string[];
}

/** Grupowanie linii w bloki (nagłówek / lista / akapit) rozdzielone pustą linią. */
function toBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;

  const flush = (): void => {
    if (current !== null && current.lines.length > 0) blocks.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flush();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, lines: [heading[2] ?? ''] });
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul !== null) {
      if (current === null || current.kind !== 'ul') {
        flush();
        current = { kind: 'ul', lines: [] };
      }
      current.lines.push(ul[1] ?? '');
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol !== null) {
      if (current === null || current.kind !== 'ol') {
        flush();
        current = { kind: 'ol', lines: [] };
      }
      current.lines.push(ol[1] ?? '');
      continue;
    }
    if (current === null || current.kind !== 'p') {
      flush();
      current = { kind: 'p', lines: [] };
    }
    current.lines.push(line.trim());
  }
  flush();
  return blocks;
}

/**
 * Markdown → HTML (string). Wejście jest escapowane w całości przed parsowaniem,
 * więc żaden tag z treści (w tym <script>, onerror=...) nie przetrwa.
 */
export function renderMarkdown(markdown: string): string {
  const escaped = escapeHtml(markdown.replace(/\r\n/g, '\n'));
  const blocks = toBlocks(escaped.split('\n'));
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') {
      // Nagłówki odpowiedzi renderujemy o poziom niżej (h1 treści ≠ h1 strony).
      const level = Math.min((block.level ?? 1) + 2, 6);
      out.push(`<h${level}>${renderInline(block.lines[0] ?? '')}</h${level}>`);
    } else if (block.kind === 'ul' || block.kind === 'ol') {
      const items = block.lines.map((l) => `<li>${renderInline(l)}</li>`).join('');
      out.push(`<${block.kind}>${items}</${block.kind}>`);
    } else {
      out.push(`<p>${renderInline(block.lines.join('<br>'))}</p>`);
    }
  }
  return out.join('\n');
}

/**
 * HTML odpowiedzi z klikalnymi cytowaniami: [n] (1 ≤ n ≤ citeCount) →
 * <button type="button" class="cite-chip" data-cite="n">[n]</button>.
 * Wołane PO renderMarkdown — generowany HTML nie zawiera '[n]' w atrybutach,
 * więc podmiana tekstowa jest bezpieczna. [n] spoza zakresu zostaje tekstem.
 */
export function renderAnswerHtml(markdown: string, citeCount: number): string {
  const html = renderMarkdown(markdown);
  if (citeCount <= 0) return html;
  return html.replace(/\[(\d{1,3})\]/g, (match, digits: string) => {
    const n = Number(digits);
    if (!Number.isInteger(n) || n < 1 || n > citeCount) return match;
    return `<button type="button" class="cite-chip" data-cite="${n}">[${n}]</button>`;
  });
}
