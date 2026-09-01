import type { ReactNode } from 'react';
import { useDialogBehavior } from './Modal';
import { t } from '../i18n/t';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/** Panel boczny (mobile: pełny ekran) — Esc + focus trap jak Modal. */
export function Drawer({ open, onClose, title, children }: DrawerProps) {
  const panelRef = useDialogBehavior(open, onClose);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div ref={panelRef} className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm" aria-label={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="stack grow">{children}</div>
      </div>
    </div>
  );
}
