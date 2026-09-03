import { Switch as RadixSwitch } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export type SwitchProps = ComponentProps<typeof RadixSwitch.Root>;

/** Przełącznik 32×18 (thumb 14px), akcent gdy włączony. */
export function Switch({ className, ...rest }: SwitchProps) {
  return (
    <RadixSwitch.Root
      className={cn(
        'inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-surface-3 transition-colors',
        'data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block size-3.5 translate-x-0.5 rounded-full bg-white shadow-xs transition-transform',
          'data-[state=checked]:translate-x-4',
        )}
      />
    </RadixSwitch.Root>
  );
}
