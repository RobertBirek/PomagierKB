/**
 * errorComponent rootRoute — błąd renderowania trasy: komunikat PL,
 * identyfikator zgłoszenia (requestId z koperty błędu, kopiowalny — po nim
 * operator znajdzie wpis w logu panel-api), przycisk Odśwież, szczegóły
 * techniczne w <details>.
 */
import type { ErrorComponentProps } from '@tanstack/react-router';
import { Button } from '@/ui/button';
import { CodeBlock } from '@/ui/code-block';
import { errorRequestId } from '@/lib/errorMessage';
import { t } from '@/i18n/t';

export function RouteError({ error }: ErrorComponentProps) {
  const details = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  const requestId = errorRequestId(error);
  return (
    <div className="mx-auto mt-8 max-w-lg rounded-lg border border-border bg-surface p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-text">{t('routeError.title')}</h2>
      <p className="mt-2 text-sm text-text-secondary">{t('routeError.description')}</p>
      {requestId !== null && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-text-secondary">{t('error.requestIdLabel')}</p>
          <CodeBlock inline code={requestId} label={t('error.requestId', { id: requestId })} />
        </div>
      )}
      <div className="mt-4">
        <Button variant="primary" onClick={() => window.location.reload()}>
          {t('routeError.reload')}
        </Button>
      </div>
      <details className="mt-4 text-xs text-text-tertiary">
        <summary className="cursor-pointer">{t('routeError.details')}</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono">{details}</pre>
      </details>
    </div>
  );
}
