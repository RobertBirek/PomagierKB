import type { ComponentProps } from 'react';
import { cn } from './cn';

/** Wspólne klasy pól formularza (Input/Textarea/Select/SearchInput). */
export const fieldControlClasses =
  'w-full bg-surface text-sm text-text border border-border-strong rounded-md ' +
  'placeholder:text-text-tertiary ' +
  'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none ' +
  'disabled:opacity-50 disabled:bg-surface-2 aria-invalid:border-fail';

export interface InputProps extends ComponentProps<'input'> {
  /** Ustawia aria-invalid (czerwony border przez aria-invalid:border-fail). */
  invalid?: boolean;
}

export function Input({ invalid, className, ...rest }: InputProps) {
  return (
    <input
      className={cn(fieldControlClasses, 'h-8 px-2.5', className)}
      {...(invalid !== undefined ? { 'aria-invalid': invalid } : {})}
      {...rest}
    />
  );
}
