/** Breadcrumbs — ścieżka nawigacji; ostatni element = bieżąca strona (aria-current). */
import { Fragment, type ReactNode } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/ui/cn';
import { t } from '@/i18n/t';

export interface BreadcrumbItem {
  label: ReactNode;
  to?: LinkProps['to'];
  search?: LinkProps['search'];
}

export interface BreadcrumbsProps {
  items: readonly BreadcrumbItem[];
  className?: string;
}

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav aria-label={t('ui.breadcrumbs')} className={cn('flex items-center gap-1 text-sm', className)}>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && (
              <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
            )}
            {!last && item.to !== undefined ? (
              <Link
                to={item.to}
                {...(item.search !== undefined ? { search: item.search } : {})}
                className="text-text-secondary hover:text-text"
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={last ? 'text-text' : 'text-text-secondary'}
                {...(last ? { 'aria-current': 'page' as const } : {})}
              >
                {item.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
