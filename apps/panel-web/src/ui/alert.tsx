import { cva } from 'class-variance-authority';
import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { cn } from './cn';

export type AlertVariant = 'info' | 'ok' | 'warn' | 'fail';

export const alertVariants = cva('flex gap-2.5 rounded-lg border p-3 text-sm', {
  variants: {
    variant: {
      info: 'bg-info-tint border-info/25',
      ok: 'bg-ok-tint border-ok/25',
      warn: 'bg-warn-tint border-warn/25',
      fail: 'bg-fail-tint border-fail/25',
    },
  },
  defaultVariants: { variant: 'info' },
});

const ICON_BY_VARIANT: Record<AlertVariant, ComponentType<{ size?: number | string }>> = {
  info: Info,
  ok: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX,
};

const ICON_COLOR: Record<AlertVariant, string> = {
  info: 'text-info',
  ok: 'text-ok',
  warn: 'text-warn',
  fail: 'text-fail',
};

export interface AlertProps {
  variant?: AlertVariant;
  title?: ReactNode;
  children: ReactNode;
  /** Własna ikona 16px (domyślna zależy od wariantu). */
  icon?: ReactNode;
  className?: string;
}

/** Blok komunikatu inline (tint + border w kolorze statusu). */
export function Alert({ variant = 'info', title, children, icon, className }: AlertProps) {
  const DefaultIcon = ICON_BY_VARIANT[variant];
  return (
    <div className={cn(alertVariants({ variant }), className)}>
      <span className={cn('mt-0.5 shrink-0', ICON_COLOR[variant])} aria-hidden="true">
        {icon ?? <DefaultIcon size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        {title !== undefined && title !== null ? (
          <div className="font-medium text-text">{title}</div>
        ) : null}
        <div className="text-text-secondary">{children}</div>
      </div>
    </div>
  );
}
