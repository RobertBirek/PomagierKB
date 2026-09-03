/**
 * AlertDialog v2 — GŁÓWNY mechanizm potwierdzania akcji destrukcyjnych.
 * Wysokopoziomowy <AlertDialog/> pokrywa 95% przypadków; prymitywy
 * (AlertDialogRoot/Content/…) — nietypowe, np. potwierdzenie przepisaniem
 * nazwy (Input przekazany przez `children`, renderowany między konsekwencjami
 * a stopką).
 *
 * Użycie:
 *   <AlertDialog
 *     open={open} onOpenChange={setOpen}
 *     title={t('kb.delete.title')}
 *     objectName={kb.name}
 *     consequences={[t('kb.delete.c1'), t('kb.delete.c2')]}
 *     confirmLabel={t('kb.delete.confirm')}
 *     destructive
 *     loading={mutation.isPending}
 *     onConfirm={() => mutation.mutate()}
 *   />
 * Uwaga: Confirm NIE zamyka dialogu sam — po sukcesie zamknij przez
 * onOpenChange(false)/setOpen(false) (wspiera akcje async z loading).
 */
import { AlertDialog as RadixAlertDialog } from 'radix-ui';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';
import { t } from '../i18n/t';
import './overlays.css';

/* ── Prymitywy (dla nietypowych przypadków) ── */

export const AlertDialogRoot = RadixAlertDialog.Root;
export const AlertDialogTrigger = RadixAlertDialog.Trigger;
export const AlertDialogCancel = RadixAlertDialog.Cancel;
export const AlertDialogAction = RadixAlertDialog.Action;

export function AlertDialogContent({ className, children, ...props }: ComponentProps<typeof RadixAlertDialog.Content>) {
  return (
    <RadixAlertDialog.Portal>
      <RadixAlertDialog.Overlay className="ui-anim-overlay fixed inset-0 z-(--z-overlay) bg-black/40 dark:bg-black/60" />
      <RadixAlertDialog.Content
        {...props}
        className={cn(
          'ui-anim-dialog fixed left-1/2 top-1/2 z-(--z-overlay) -translate-x-1/2 -translate-y-1/2',
          'flex w-[calc(100vw-32px)] max-w-[420px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg outline-none',
          className,
        )}
      >
        {children}
      </RadixAlertDialog.Content>
    </RadixAlertDialog.Portal>
  );
}

export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof RadixAlertDialog.Title>) {
  return <RadixAlertDialog.Title {...props} className={cn('px-5 pt-4 text-lg font-semibold', className)} />;
}

export function AlertDialogDescription({ className, ...props }: ComponentProps<typeof RadixAlertDialog.Description>) {
  return <RadixAlertDialog.Description {...props} className={cn('px-5 pt-1 text-sm text-text-secondary', className)} />;
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cn('mt-4 flex justify-end gap-2 border-t border-border px-5 py-3', className)} />;
}

/** Lista konsekwencji z ikoną ostrzeżenia — współdzielona z wariantem wysokopoziomowym. */
export function AlertDialogConsequences({ items, className }: { items: string[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className={cn('flex flex-col gap-1.5 px-5 pt-3 text-sm text-text-secondary', className)}>
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── Wariant wysokopoziomowy ── */

export interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Nazwa obiektu, którego dotyczy akcja (wyróżniona <strong>). */
  objectName?: string;
  /** Lista konsekwencji (każda z ikoną ostrzeżenia). */
  consequences?: string[];
  confirmLabel: string;
  /** Domyślnie ui.cancel („Anuluj"). */
  cancelLabel?: string;
  /** true = przycisk potwierdzenia w kolorze danger (destrukcja). */
  destructive?: boolean;
  /** Trwa akcja — spinner na Confirm, oba przyciski zablokowane. */
  loading?: boolean;
  /** Nie zamyka dialogu — zamknij po sukcesie przez onOpenChange(false). */
  onConfirm: () => void;
  /** Dodatkowa treść między konsekwencjami a stopką (np. pole przepisania nazwy). */
  children?: ReactNode;
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  objectName,
  consequences = [],
  confirmLabel,
  cancelLabel,
  destructive = false,
  loading = false,
  onConfirm,
  children,
}: AlertDialogProps) {
  return (
    <RadixAlertDialog.Root open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {objectName !== undefined && (
          <AlertDialogDescription>
            <strong className="font-medium text-text">{objectName}</strong>
          </AlertDialogDescription>
        )}
        <AlertDialogConsequences items={consequences} />
        {children !== undefined && <div className="px-5 pt-3">{children}</div>}
        <AlertDialogFooter>
          <RadixAlertDialog.Cancel
            disabled={loading}
            className="inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-sm transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-60"
          >
            {cancelLabel ?? t('ui.cancel')}
          </RadixAlertDialog.Cancel>
          {/* Celowo NIE RadixAlertDialog.Action — Action zamyka dialog od razu,
              a chcemy wspierać async (loading) i zamknięcie po sukcesie. */}
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-60',
              destructive
                ? 'bg-fail text-white hover:opacity-90'
                : 'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active',
            )}
          >
            {loading && <LoaderCircle size={16} className="animate-spin" aria-hidden />}
            {confirmLabel}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </RadixAlertDialog.Root>
  );
}
