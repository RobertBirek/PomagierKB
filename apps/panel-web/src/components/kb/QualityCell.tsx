/**
 * Kolumna „Ocena jakości" — REALNE dane z GET /api/v1/kbs/:ns/quality
 * (per-wiersz useQuery, staleTime 60 s). Werdykt jako Badge (etykieta PL
 * z backendu — humanize), pod spodem data oceny; brak raportu → muted
 * z Tooltipem „uruchom ocenę z menu".
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/ui/badge';
import { Skeleton } from '@/ui/skeleton';
import { Tooltip } from '@/ui/tooltip';
import { t, formatDateTime } from '@/i18n/t';
import type { QualityReport } from './types';

/** Werdykt quality gate (OK/WARN/FAIL) → wariant plakietki kitu. */
export function verdictVariant(verdict: string): 'ok' | 'warn' | 'fail' | 'neutral' {
  const v = verdict.trim().toUpperCase();
  if (v === 'OK') return 'ok';
  if (v === 'WARN') return 'warn';
  if (v === 'FAIL') return 'fail';
  return 'neutral';
}

export function useQualityReport(namespace: string | null) {
  return useQuery({
    queryKey: ['kbs', namespace, 'quality'],
    queryFn: () => apiFetch<{ report: QualityReport | null }>(`/api/v1/kbs/${namespace}/quality`),
    enabled: namespace !== null,
    staleTime: 60_000,
  });
}

export function QualityCell({ namespace }: { namespace: string }) {
  const query = useQualityReport(namespace);

  if (query.isPending) return <Skeleton className="h-4 w-20" />;
  // Błąd odczytu raportu nie może wywracać wiersza — pokazujemy „brak oceny".
  const report = query.data?.report ?? null;
  if (report === null) {
    return (
      <Tooltip content={t('kb.quality.noReportHint')}>
        <span className="text-text-tertiary">{t('kb.quality.noReport')}</span>
      </Tooltip>
    );
  }
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge variant={verdictVariant(report.verdict)} dot>
        {report.verdictLabel}
      </Badge>
      <span className="text-xs text-text-tertiary">{formatDateTime(report.createdAt)}</span>
    </div>
  );
}
