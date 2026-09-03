import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from './cn';
import { fieldControlClasses } from './input';

export interface SelectProps extends ComponentProps<'select'> {
  /** Ustawia aria-invalid (czerwony border). */
  invalid?: boolean;
  /** Klasy wrappera (szerokość/układ); className idzie na <select>. */
  wrapperClassName?: string;
}

/** Stylowany natywny <select> z własnym chevronem. Opcje przez children. */
export function Select({ invalid, className, wrapperClassName, children, ...rest }: SelectProps) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      <select
        className={cn(fieldControlClasses, 'h-8 appearance-none pl-2.5 pr-8', className)}
        {...(invalid !== undefined ? { 'aria-invalid': invalid } : {})}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary"
        aria-hidden="true"
      />
    </div>
  );
}
