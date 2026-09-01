import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '../i18n/t';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Pułapka fokusa + Esc — współdzielona przez Modal i Drawer. */
export function useDialogBehavior(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    function onKeyDown(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        onClose();
        return;
      }
      if (ev.key !== 'Tab' || panel === null) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (firstEl === undefined || lastEl === undefined) return;
      const active = document.activeElement;
      if (ev.shiftKey && (active === firstEl || active === panel)) {
        ev.preventDefault();
        lastEl.focus();
      } else if (!ev.shiftKey && active === lastEl) {
        ev.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  return panelRef;
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Szerszy wariant (np. tabele preflight). */
  wide?: boolean;
  /** Stopka (przyciski akcji). */
  footer?: ReactNode;
}

export function Modal({ open, onClose, title, children, wide = false, footer }: ModalProps) {
  const panelRef = useDialogBehavior(open, onClose);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={wide ? 'modal modal-wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="row">
          <h2 className="modal-title grow">{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm" aria-label={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="stack">{children}</div>
        {footer !== undefined && (
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
