/**
 * Popover v2 — na Radix Popover; wygląd spójny z DropdownMenuContent
 * (bogatsza treść niż menu: filtry, mini-formularze, podglądy).
 *
 * Użycie:
 *   <Popover>
 *     <PopoverTrigger asChild><button>Filtry</button></PopoverTrigger>
 *     <PopoverContent align="start">…</PopoverContent>
 *   </Popover>
 */
import { Popover as RadixPopover } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';
import './overlays.css';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

export function PopoverContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        {...props}
        sideOffset={sideOffset}
        className={cn(
          'ui-anim-pop z-(--z-popover) min-w-44 rounded-lg border border-border bg-surface p-3 shadow-md outline-none',
          className,
        )}
      />
    </RadixPopover.Portal>
  );
}
