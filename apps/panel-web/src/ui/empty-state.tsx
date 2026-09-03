/**
 * EmptyState v2 — pusty stan z ikoną Lucide i CTA (components/EmptyState.tsx
 * to legacy z emoji; migracja stron w Fazie 3).
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/ui/cn';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** CTA — puste stany z konkretną akcją. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
      {Icon !== undefined && (
        <div
          className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-text-tertiary"
          aria-hidden="true"
        >
          <Icon size={24} />
        </div>
      )}
      <h3 className="text-base font-medium text-text">{title}</h3>
      {description !== undefined && (
        <p className="mt-1 max-w-md text-sm text-text-secondary">{description}</p>
      )}
      {action !== undefined && <div className="mt-4 flex items-center gap-2">{action}</div>}
    </div>
  );
}
