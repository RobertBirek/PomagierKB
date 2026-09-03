/**
 * MetricTile — kafelek metryki (cockpit/inbox/kb). Klikalny wariant to
 * <button aria-pressed> pełnej szerokości (filtr-przełącznik).
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/ui/cn';

export type MetricTone = 'default' | 'ok' | 'warn' | 'fail' | 'accent';

export interface MetricTileProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: MetricTone;
  /** Stan wciśnięcia (filtr aktywny) — tylko dla wariantu klikalnego. */
  active?: boolean;
  onClick?: () => void;
  className?: string;
}

const TONE_TEXT: Record<MetricTone, string> = {
  default: 'text-text',
  ok: 'text-ok',
  warn: 'text-warn',
  fail: 'text-fail',
  accent: 'text-accent',
};

export function MetricTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  active,
  onClick,
  className,
}: MetricTileProps) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-text-secondary">{label}</span>
        {Icon !== undefined && (
          <Icon
            size={16}
            aria-hidden="true"
            className={cn('shrink-0', tone === 'default' ? 'text-text-tertiary' : TONE_TEXT[tone])}
          />
        )}
      </div>
      <div className={cn('mt-1 text-3xl font-semibold tabular-nums', TONE_TEXT[tone])}>{value}</div>
      {hint !== undefined && <div className="mt-1 text-xs text-text-tertiary">{hint}</div>}
    </>
  );

  const card = cn(
    'block w-full rounded-lg border border-border bg-surface p-4 text-left',
    onClick !== undefined && 'cursor-pointer transition-colors hover:bg-surface-2',
    active === true && 'border-accent',
    className,
  );

  if (onClick !== undefined) {
    return (
      <button
        type="button"
        className={card}
        onClick={onClick}
        {...(active !== undefined ? { 'aria-pressed': active } : {})}
      >
        {content}
      </button>
    );
  }
  return <div className={card}>{content}</div>;
}
