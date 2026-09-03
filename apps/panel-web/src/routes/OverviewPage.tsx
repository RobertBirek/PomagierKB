/**
 * /overview — TYMCZASOWY placeholder. Właściwy Przegląd (statystyki, skróty,
 * ostatnia aktywność) powstaje w Fazie 3 — agent strony podmienia ZAWARTOŚĆ
 * tego pliku, nie router.
 */
import { t } from '@/i18n/t';

export function OverviewPage() {
  return (
    <div className="rounded-lg border border-border bg-surface p-6">
      <h2 className="text-lg font-semibold text-text">{t('nav.overview')}</h2>
      <p className="mt-2 text-sm text-text-secondary">{t('overview.placeholder')}</p>
    </div>
  );
}
