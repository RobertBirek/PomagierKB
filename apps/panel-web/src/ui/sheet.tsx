/**
 * Sheet v2 — Dialog w wariancie bocznym (panel z prawej) lub dolnym (mobile).
 * Zastępuje components/Drawer.tsx w stronach (migracja etapami).
 *
 * Użycie:
 *   <Sheet open={open} onOpenChange={setOpen}>
 *     <SheetContent side="right" size="md">
 *       <SheetHeader><SheetTitle>Szczegóły</SheetTitle></SheetHeader>
 *       <SheetBody>…</SheetBody>
 *       <SheetFooter>…</SheetFooter>
 *     </SheetContent>
 *   </Sheet>
 */
import { Dialog as RadixDialog } from 'radix-ui';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from './cn';
import { t } from '../i18n/t';
import { DialogOverlay } from './dialog';
import './overlays.css';

export const Sheet = RadixDialog.Root;
export const SheetTrigger = RadixDialog.Trigger;
export const SheetClose = RadixDialog.Close;

export type SheetSide = 'right' | 'bottom';
export type SheetSize = 'sm' | 'md' | 'lg';

/* right: max-w-full ogranicza szerokość na mobile (<768px panel zajmuje cały ekran). */
const SIZE_CLASS: Record<SheetSize, string> = {
  sm: 'w-[380px]',
  md: 'w-[480px]',
  lg: 'w-[640px]',
};

const SIDE_CLASS: Record<SheetSide, string> = {
  right: 'ui-anim-sheet-right inset-y-0 right-0 h-full max-w-full border-l border-border',
  bottom: 'ui-anim-sheet-bottom inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-xl border-t border-border',
};

export interface SheetContentProps extends ComponentProps<typeof RadixDialog.Content> {
  side?: SheetSide;
  /** Szerokość panelu (tylko side="right"). */
  size?: SheetSize;
  /** Ukryj przycisk X w rogu. */
  hideClose?: boolean;
}

export function SheetContent({
  side = 'right',
  size = 'md',
  hideClose = false,
  className,
  children,
  ...props
}: SheetContentProps) {
  return (
    <RadixDialog.Portal>
      <DialogOverlay />
      <RadixDialog.Content
        {...props}
        className={cn(
          'fixed z-(--z-overlay) flex flex-col overflow-hidden bg-surface shadow-lg outline-none',
          SIDE_CLASS[side],
          side === 'right' && SIZE_CLASS[size],
          className,
        )}
      >
        {children}
        {!hideClose && (
          <RadixDialog.Close
            className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
            aria-label={t('ui.close')}
          >
            <X size={16} aria-hidden />
          </RadixDialog.Close>
        )}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cn('flex flex-col gap-1 border-b border-border px-5 pb-3 pr-10 pt-4', className)} />;
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof RadixDialog.Title>) {
  return <RadixDialog.Title {...props} className={cn('text-lg font-semibold', className)} />;
}

export function SheetDescription({ className, ...props }: ComponentProps<typeof RadixDialog.Description>) {
  return <RadixDialog.Description {...props} className={cn('text-sm text-text-secondary', className)} />;
}

export function SheetBody({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cn('min-h-0 grow overflow-y-auto px-5 py-4', className)} />;
}

export function SheetFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cn('flex justify-end gap-2 border-t border-border px-5 py-3', className)} />;
}
