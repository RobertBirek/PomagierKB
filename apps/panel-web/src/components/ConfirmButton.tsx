import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n/t';

export interface ConfirmButtonProps {
  onConfirm: () => void;
  children: ReactNode;
  /** Tekst w stanie uzbrojonym (domyślnie „Na pewno?"). */
  confirmLabel?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}

/**
 * Przycisk dwuklikowy dla akcji destrukcyjnych: pierwszy klik uzbraja
 * („Na pewno?"), drugi w ciągu 4 s wykonuje; potem auto-rozbrojenie.
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel,
  className = 'btn btn-danger',
  disabled = false,
  title,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function onClick(): void {
    if (!armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => setArmed(false), 4000);
      return;
    }
    window.clearTimeout(timer.current);
    setArmed(false);
    onConfirm();
  }

  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={onClick}
      {...(title !== undefined ? { title } : {})}
    >
      {armed ? (confirmLabel ?? t('common.areYouSure')) : children}
    </button>
  );
}
