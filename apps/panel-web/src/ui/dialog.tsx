/**
 * Dialog v2 (design system) — na Radix Dialog: portal, focus trap, scroll-lock
 * i Esc za darmo. Zastępuje components/Modal.tsx w stronach (migracja etapami).
 *
 * Użycie:
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogContent size="md">
 *       <DialogHeader>
 *         <DialogTitle>Tytuł</DialogTitle>
 *         <DialogDescription>Opcjonalny opis.</DialogDescription>
 *       </DialogHeader>
 *       <DialogBody>…</DialogBody>
 *       <DialogFooter>
 *         <DialogClose asChild><button>…</button></DialogClose>
 *       </DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 */
import { Dialog as RadixDialog } from 'radix-ui';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from './cn';
import { t } from '../i18n/t';
import './overlays.css';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export type DialogSize = 'sm' | 'md' | 'lg' | 'full';

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[860px]',
  full: 'max-w-[calc(100vw-32px)] h-[calc(100dvh-32px)]',
};

/** Scrim — eksportowany też dla sheet.tsx (ten sam wygląd i animacja). */
export function DialogOverlay({ className, ...props }: ComponentProps<typeof RadixDialog.Overlay>) {
  return (
    <RadixDialog.Overlay
      {...props}
      className={cn('ui-anim-overlay fixed inset-0 z-(--z-overlay) bg-black/40 dark:bg-black/60', className)}
    />
  );
}

export interface DialogContentProps extends ComponentProps<typeof RadixDialog.Content> {
  size?: DialogSize;
  /** Ukryj przycisk X w rogu (np. wymuszony wybór w stopce). */
  hideClose?: boolean;
}

export function DialogContent({ size = 'md', hideClose = false, className, children, ...props }: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <DialogOverlay />
      <RadixDialog.Content
        {...props}
        className={cn(
          'ui-anim-dialog fixed left-1/2 top-1/2 z-(--z-overlay) -translate-x-1/2 -translate-y-1/2',
          'flex w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg outline-none',
          SIZE_CLASS[size],
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

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  // pr-10 — miejsce na przycisk X w rogu.
  return <div {...props} className={cn('flex flex-col gap-1 px-5 pb-2 pr-10 pt-4', className)} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof RadixDialog.Title>) {
  return <RadixDialog.Title {...props} className={cn('text-lg font-semibold', className)} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof RadixDialog.Description>) {
  return <RadixDialog.Description {...props} className={cn('text-sm text-text-secondary', className)} />;
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cn('max-h-[70vh] overflow-y-auto px-5 py-4', className)} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cn('flex justify-end gap-2 border-t border-border px-5 py-3', className)} />;
}
