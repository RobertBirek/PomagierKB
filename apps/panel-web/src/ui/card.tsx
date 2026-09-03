import type { ComponentProps } from 'react';
import { cn } from './cn';

export interface CardProps extends ComponentProps<'div'> {
  /** flat = wypełnienie surface-2 bez bordera (sekcje wewnętrzne). */
  variant?: 'default' | 'flat';
}

export function Card({ variant = 'default', className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg',
        variant === 'flat' ? 'bg-surface-2' : 'border border-border bg-surface',
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-3 border-b border-border px-4 py-3', className)}
      {...rest}
    />
  );
}

export function CardTitle({ className, ...rest }: ComponentProps<'h3'>) {
  return <h3 className={cn('text-lg font-semibold text-text', className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-text-secondary', className)} {...rest} />;
}

export function CardBody({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('p-4', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-3 border-t border-border px-4 py-3', className)}
      {...rest}
    />
  );
}
