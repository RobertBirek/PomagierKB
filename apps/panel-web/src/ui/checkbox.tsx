import { Check, Minus } from 'lucide-react';
import { Checkbox as RadixCheckbox } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export type CheckboxProps = ComponentProps<typeof RadixCheckbox.Root>;

/**
 * Checkbox 16px na prymitywie Radix. Stan nieokreślony: checked='indeterminate'
 * (ikona Minus zamiast Check).
 */
export function Checkbox({ className, checked, ...rest }: CheckboxProps) {
  return (
    <RadixCheckbox.Root
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-border-strong bg-surface transition-colors',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-on-accent',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-on-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...(checked !== undefined ? { checked } : {})}
      {...rest}
    >
      <RadixCheckbox.Indicator className="flex items-center justify-center text-current">
        {checked === 'indeterminate' ? <Minus size={12} /> : <Check size={12} />}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}
