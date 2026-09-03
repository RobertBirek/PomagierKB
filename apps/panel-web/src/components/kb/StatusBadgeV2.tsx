/**
 * StatusBadge v2 — surowy status API → plakietka z kitu (ui/badge) przez
 * NIETYKALNY słownik lib/status (statusVariant/statusLabel). Zastępuje legacy
 * components/StatusBadge.tsx na stronach zmigrowanych (/kb, /mcp).
 */
import { Badge } from '@/ui/badge';
import { statusLabel, statusVariant, type BadgeVariant } from '@/lib/status';

/** BadgeVariant z lib/status pokrywa się z wariantami kitu (bez 'info'). */
export interface StatusBadgeV2Props {
  status?: string | null;
  /** Nadpisanie etykiety (domyślnie statusLabel(status)). */
  label?: string;
  /** Nadpisanie wariantu (domyślnie statusVariant(status)). */
  variant?: BadgeVariant;
  className?: string;
}

export function StatusBadgeV2({ status, label, variant, className }: StatusBadgeV2Props) {
  return (
    <Badge
      variant={variant ?? statusVariant(status)}
      dot
      {...(className !== undefined ? { className } : {})}
    >
      {label ?? statusLabel(status)}
    </Badge>
  );
}
