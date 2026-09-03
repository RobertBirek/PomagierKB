import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export const badgeVariants = cva(
  'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-2xs font-medium',
  {
    variants: {
      variant: { ok: '', warn: '', fail: '', info: '', accent: '', neutral: '' },
      tone: { tint: '', outline: 'border bg-transparent' },
    },
    compoundVariants: [
      // tint: tło-tint + tekst statusowy + delikatny border
      { variant: 'ok', tone: 'tint', class: 'bg-ok-tint text-ok border border-ok/25' },
      { variant: 'warn', tone: 'tint', class: 'bg-warn-tint text-warn border border-warn/25' },
      { variant: 'fail', tone: 'tint', class: 'bg-fail-tint text-fail border border-fail/25' },
      { variant: 'info', tone: 'tint', class: 'bg-info-tint text-info border border-info/25' },
      { variant: 'accent', tone: 'tint', class: 'bg-accent-tint text-accent border border-accent/25' },
      { variant: 'neutral', tone: 'tint', class: 'bg-surface-2 text-text-secondary border border-border' },
      // outline: sam border + tekst
      { variant: 'ok', tone: 'outline', class: 'border-ok/40 text-ok' },
      { variant: 'warn', tone: 'outline', class: 'border-warn/40 text-warn' },
      { variant: 'fail', tone: 'outline', class: 'border-fail/40 text-fail' },
      { variant: 'info', tone: 'outline', class: 'border-info/40 text-info' },
      { variant: 'accent', tone: 'outline', class: 'border-accent/40 text-accent' },
      { variant: 'neutral', tone: 'outline', class: 'border-border-strong text-text-secondary' },
    ],
    defaultVariants: { variant: 'neutral', tone: 'tint' },
  },
);

export interface BadgeProps extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  /** Kropka statusowa 6px w kolorze tekstu. */
  dot?: boolean;
}

export function Badge({ variant, tone, dot = false, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, tone }), className)} {...rest}>
      {dot ? <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
