/**
 * DropdownMenu v2 — na Radix DropdownMenu (portal, klawiatura, typeahead).
 *
 * Użycie:
 *   <DropdownMenu>
 *     <DropdownMenuTrigger asChild><button>…</button></DropdownMenuTrigger>
 *     <DropdownMenuContent align="end">
 *       <DropdownMenuLabel>Akcje</DropdownMenuLabel>
 *       <DropdownMenuItem onSelect={...}><Pencil size={16}/> Edytuj</DropdownMenuItem>
 *       <DropdownMenuSeparator />
 *       <DropdownMenuItem destructive onSelect={...}><Trash2 size={16}/> Usuń</DropdownMenuItem>
 *     </DropdownMenuContent>
 *   </DropdownMenu>
 */
import { DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';
import './overlays.css';

export const DropdownMenu = RadixDropdownMenu.Root;
export const DropdownMenuTrigger = RadixDropdownMenu.Trigger;
export const DropdownMenuGroup = RadixDropdownMenu.Group;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof RadixDropdownMenu.Content>) {
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.Content
        {...props}
        sideOffset={sideOffset}
        className={cn(
          'ui-anim-pop z-(--z-popover) min-w-44 rounded-lg border border-border bg-surface p-1 shadow-md',
          className,
        )}
      />
    </RadixDropdownMenu.Portal>
  );
}

export interface DropdownMenuItemProps extends ComponentProps<typeof RadixDropdownMenu.Item> {
  /** Akcja destrukcyjna — czerwony tekst i tint na podświetleniu. */
  destructive?: boolean;
}

export function DropdownMenuItem({ destructive = false, className, ...props }: DropdownMenuItemProps) {
  return (
    <RadixDropdownMenu.Item
      {...props}
      className={cn(
        'flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none',
        'data-disabled:pointer-events-none data-disabled:opacity-50',
        destructive ? 'text-fail data-highlighted:bg-fail-tint' : 'data-highlighted:bg-surface-2',
        className,
      )}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof RadixDropdownMenu.Separator>) {
  return <RadixDropdownMenu.Separator {...props} className={cn('my-1 h-px bg-border', className)} />;
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof RadixDropdownMenu.Label>) {
  return <RadixDropdownMenu.Label {...props} className={cn('px-2 py-1.5 text-xs text-text-tertiary', className)} />;
}
