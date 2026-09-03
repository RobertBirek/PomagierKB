/**
 * errorComponent rootRoute — błąd renderowania trasy: komunikat PL,
 * przycisk Odśwież, szczegóły techniczne w <details>.
 */
import type { ErrorComponentProps } from '@tanstack/react-router';
import { t } from '@/i18n/t';

export function RouteError({ error }: ErrorComponentProps) {
  const details = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  return (
    <div className="mx-auto mt-8 max-w-lg rounded-lg border border-border bg-surface p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-text">{t('routeError.title')}</h2>
      <p className="mt-2 text-sm text-text-secondary">{t('routeError.description')}</p>
      <div className="mt-4">
        <button
          type="button"
          className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-hover"
          onClick={() => window.location.reload()}
        >
          {t('routeError.reload')}
        </button>
      </div>
      <details className="mt-4 text-xs text-text-tertiary">
        <summary className="cursor-pointer">{t('routeError.details')}</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono">{details}</pre>
      </details>
    </div>
  );
}
