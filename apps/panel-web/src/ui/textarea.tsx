import type { ComponentProps } from 'react';
import { cn } from './cn';
import { fieldControlClasses } from './input';

export interface TextareaProps extends ComponentProps<'textarea'> {
  /** Ustawia aria-invalid (czerwony border). */
  invalid?: boolean;
}

export function Textarea({ invalid, className, ...rest }: TextareaProps) {
  return (
    <textarea
      className={cn(fieldControlClasses, 'min-h-20 px-2.5 py-2', className)}
      {...(invalid !== undefined ? { 'aria-invalid': invalid } : {})}
      {...rest}
    />
  );
}
