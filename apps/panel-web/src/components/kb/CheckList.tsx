/**
 * CheckList — lista checków (preflight builda / raport quality gate) w trzech
 * odmianach: zaliczone (ok), ostrzeżenia (warn), blokady/błędy (fail).
 * Wzorzec współdzielony przez KbBuildDialog i KbDetailsSheet.
 */
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';
import { cn } from '@/ui/cn';

export interface CheckListItem {
  id: string;
  /** Ludzka etykieta checka (słownik PL — bez surowych id). */
  label: string;
  /** Komunikat szczegółowy (przychodzi z backendu po polsku). */
  message: string;
}

export type CheckListKind = 'ok' | 'warn' | 'fail';

const ICON = {
  ok: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX,
} as const;

const ICON_COLOR: Record<CheckListKind, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  fail: 'text-fail',
};

export function CheckList({
  title,
  kind,
  items,
}: {
  title: string;
  kind: CheckListKind;
  items: readonly CheckListItem[];
}) {
  if (items.length === 0) return null;
  const Icon = ICON[kind];
  return (
    <section>
      <h3 className="mb-1.5 text-sm font-medium text-text">{title}</h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-sm">
            <Icon size={16} aria-hidden="true" className={cn('mt-0.5 shrink-0', ICON_COLOR[kind])} />
            <span className="min-w-0">
              <span className="font-medium text-text">{item.label}</span>
              {item.message !== '' && <span className="text-text-secondary"> — {item.message}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
