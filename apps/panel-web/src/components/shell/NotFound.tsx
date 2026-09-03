/** notFoundComponent rootRoute — nieistniejący adres → CTA na /ask. */
import { Link } from '@tanstack/react-router';
import { SearchX } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { t } from '@/i18n/t';

export function NotFound() {
  return (
    <EmptyState
      icon={<SearchX size={32} aria-hidden="true" />}
      title={t('notFound.title')}
      description={t('notFound.description')}
      action={
        <Link
          to="/ask"
          className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          {t('notFound.goAsk')}
        </Link>
      }
    />
  );
}
