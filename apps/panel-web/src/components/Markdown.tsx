/**
 * Markdown — nadbudowa nad lib/markdown (NIETYKALNY): dodaje code-fence ```
 * i tabele GFM. Fence'y i tabele są WYCINANE przed przekazaniem do lib
 * (extractFences/splitTables z lib/markdownExtras), renderowane osobno z pełnym
 * escapowaniem, a wynik sklejany — więc XSS-gwarancje lib pozostają w mocy.
 * Cytowania [n]: delegacja kliknięć na kontenerze (button[data-cite] z lib).
 */
import { useMemo, type MouseEvent } from 'react';
import { renderAnswerHtml, renderMarkdown } from '@/lib/markdown';
import {
  extractFences,
  renderFenceHtml,
  renderTables,
  splitTables,
} from '@/lib/markdownExtras';
import { cn } from '@/ui/cn';

export interface MarkdownProps {
  text: string;
  /** [n] → klikalne chipy (renderAnswerHtml zamiast renderMarkdown). */
  withCitations?: boolean;
  /** Górny zakres [n]; bez podania — do 999 (limit regexa lib). */
  citeCount?: number;
  onCitationClick?: (n: number) => void;
  className?: string;
}

/** Klasy typograficzne .prose-v2 — spójne z tokenami design systemu. */
const PROSE = cn(
  'text-sm leading-relaxed text-text',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold',
  '[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold',
  '[&_h5]:mt-3 [&_h5]:mb-1 [&_h5]:text-sm [&_h5]:font-medium',
  '[&_h6]:mt-2 [&_h6]:mb-1 [&_h6]:text-xs [&_h6]:font-medium',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-0.5',
  '[&_strong]:font-semibold',
  '[&_code]:font-mono [&_code]:text-[0.9em] [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:rounded-sm',
  '[&_pre]:my-3 [&_pre]:bg-surface-2 [&_pre]:border [&_pre]:border-border [&_pre]:p-3',
  '[&_pre]:rounded-lg [&_pre]:overflow-x-auto',
  '[&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:text-xs',
  '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
  '[&_th]:text-left [&_th]:font-medium [&_th]:text-text-secondary',
  '[&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1',
  '[&_td]:border-b [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1',
);

export function Markdown({
  text,
  withCitations,
  citeCount,
  onCitationClick,
  className,
}: MarkdownProps) {
  const html = useMemo(() => {
    const renderText = (md: string): string =>
      withCitations === true ? renderAnswerHtml(md, citeCount ?? 999) : renderMarkdown(md);
    return extractFences(text)
      .map((seg) => {
        if (seg.kind === 'fence') return renderFenceHtml(seg.content, seg.lang);
        return splitTables(seg.content)
          .map((sub) => (sub.kind === 'table' ? renderTables(sub.content) : renderText(sub.content)))
          .join('\n');
      })
      .join('\n');
  }, [text, withCitations, citeCount]);

  function handleClick(e: MouseEvent<HTMLDivElement>): void {
    if (onCitationClick === undefined) return;
    const target = e.target as HTMLElement;
    const chip = target.closest('button[data-cite]');
    if (chip === null) return;
    const n = Number(chip.getAttribute('data-cite'));
    if (Number.isInteger(n) && n >= 1) onCitationClick(n);
  }

  return (
    <div
      className={cn(PROSE, className)}
      onClick={handleClick}
      // Bezpieczne: całość HTML pochodzi z lib/markdown (escapuje wejście)
      // oraz z markdownExtras (escapeHtml na każdej treści fence/tabeli).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
