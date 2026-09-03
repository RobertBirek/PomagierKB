import type { ComponentProps } from 'react';
import { cn } from './cn';

/** Klawisz skrótu, np. <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ className, ...rest }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex min-w-[18px] justify-center rounded-sm border border-border bg-surface-2 px-1 font-mono text-2xs text-text-secondary',
        'shadow-[inset_0_-1px_0_var(--color-border)]',
        className,
      )}
      {...rest}
    />
  );
}
