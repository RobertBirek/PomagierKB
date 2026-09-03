/**
 * CodeBlock — blok kodu / jednoliniowy snippet z przyciskiem kopiowania
 * (zastąpi components/CopyField.tsx w Fazie 3; legacy nietykalny).
 * Odmowa clipboard → zaznaczenie treści + tytuł „skopiuj ręcznie" (bez toastu).
 */
import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/ui/cn';
import { t } from '@/i18n/t';

export interface CodeBlockProps {
  code: string;
  /** Informacyjnie (data-lang) — bez podświetlania składni. */
  language?: string;
  copyable?: boolean;
  /** Blok: ogranicz wysokość (np. 240 lub '18rem') + przewijanie pionowe. */
  maxHeight?: number | string;
  /** Jednoliniowy układ (code + przycisk) — jak legacy CopyField. */
  inline?: boolean;
  /** Etykieta dostępności treści (np. „Klucz API"). */
  label?: string;
  className?: string;
}

export function CodeBlock({
  code,
  language,
  copyable = true,
  maxHeight,
  inline,
  label,
  className,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const codeRef = useRef<HTMLElement | null>(null);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback klawiaturowy: zaznacz treść, użytkownik kopiuje Ctrl+C.
      setFailed(true);
      const node = codeRef.current;
      if (node !== null) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }

  const copyButton = copyable ? (
    <button
      type="button"
      aria-label={t('ui.copyCode')}
      title={failed ? t('ui.copyManually') : t('ui.copyCode')}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border',
        'bg-surface text-text-secondary hover:bg-surface-2 hover:text-text',
      )}
      onClick={() => void copy()}
    >
      {copied ? (
        <Check size={14} aria-hidden="true" className="text-ok" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </button>
  ) : null;

  const langAttr = language !== undefined ? { 'data-lang': language } : {};
  const labelAttr = label !== undefined ? { 'aria-label': label } : {};

  if (inline === true) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2 py-1',
          className,
        )}
      >
        <code
          ref={codeRef}
          className="min-w-0 flex-1 truncate font-mono text-xs text-text"
          {...langAttr}
          {...labelAttr}
        >
          {code}
        </code>
        {copyButton}
      </div>
    );
  }

  return (
    <div className={cn('relative', className)}>
      <pre
        className={cn(
          'overflow-auto rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs text-text',
          maxHeight !== undefined && 'overflow-y-auto',
        )}
        {...(maxHeight !== undefined ? { style: { maxHeight } } : {})}
      >
        <code ref={codeRef} {...langAttr} {...labelAttr}>
          {code}
        </code>
      </pre>
      {copyButton !== null && <div className="absolute top-2 right-2">{copyButton}</div>}
    </div>
  );
}
