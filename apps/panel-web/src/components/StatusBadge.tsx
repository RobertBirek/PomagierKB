import { statusLabel, statusVariant, type BadgeVariant } from '../lib/status';

export interface StatusBadgeProps {
  /** Surowy status z API (running/done/active/FINISH...) — mapowany słownikiem. */
  status?: string | null;
  /** Nadpisanie etykiety (domyślnie statusLabel(status)). */
  label?: string;
  /** Nadpisanie wariantu koloru (domyślnie statusVariant(status)). */
  variant?: BadgeVariant;
}

/** Plakietka statusu — kolor i polska etykieta ze słownika komunikatów (lib/status.ts). */
export function StatusBadge({ status, label, variant }: StatusBadgeProps) {
  const v = variant ?? statusVariant(status);
  const text = label ?? statusLabel(status);
  return (
    <span className={`badge badge-${v}`}>
      <span className="badge-dot" aria-hidden="true" />
      {text}
    </span>
  );
}
