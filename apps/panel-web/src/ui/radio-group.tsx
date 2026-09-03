import { RadioGroup as RadixRadioGroup } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export type RadioGroupProps = ComponentProps<typeof RadixRadioGroup.Root>;

/** Grupa radio (Radix) — domyślnie pionowy stack gap-2. */
export function RadioGroup({ className, ...rest }: RadioGroupProps) {
  return <RadixRadioGroup.Root className={cn('grid gap-2', className)} {...rest} />;
}

export type RadioGroupItemProps = ComponentProps<typeof RadixRadioGroup.Item>;

/** Pojedynczy przycisk radio 16px z kropką 8px gdy zaznaczony. */
export function RadioGroupItem({ className, ...rest }: RadioGroupItemProps) {
  return (
    <RadixRadioGroup.Item
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface transition-colors',
        'data-[state=checked]:border-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      <RadixRadioGroup.Indicator className="flex items-center justify-center">
        <span className="size-2 rounded-full bg-accent" />
      </RadixRadioGroup.Indicator>
    </RadixRadioGroup.Item>
  );
}
