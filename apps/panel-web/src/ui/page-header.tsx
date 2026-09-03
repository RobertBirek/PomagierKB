/** PageHeader — nagłówek strony: tytuł, opis, akcje po prawej, slot tabów, backTo. */
import type { ReactNode } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/ui/cn';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Przyciski po prawej (flex gap-2). */
  actions?: ReactNode;
  /** Slot pod nagłówkiem (np. <Tabs/>), dosunięty do dolnej krawędzi. */
  tabs?: ReactNode;
  /** Link powrotny nad tytułem. */
  backTo?: { to: NonNullable<LinkProps['to']>; label: string; search?: LinkProps['search'] };
  className?: string;
}

export function PageHeader({ title, description, actions, tabs, backTo, className }: PageHeaderProps) {
  return (
    <header className={cn('mb-5', className)}>
      {backTo !== undefined && (
        <Link
          to={backTo.to}
          {...(backTo.search !== undefined ? { search: backTo.search } : {})}
          className="mb-2 inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text"
        >
          <ChevronLeft size={14} aria-hidden="true" />
          {backTo.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-text">{title}</h1>
          {description !== undefined && (
            <p className="mt-1 text-sm text-text-secondary">{description}</p>
          )}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {tabs !== undefined && <div className="mt-3 -mb-px">{tabs}</div>}
    </header>
  );
}
