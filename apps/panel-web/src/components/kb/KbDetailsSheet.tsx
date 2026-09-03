/**
 * Sheet szczegółów bazy (lg): meta, REALNY raport jakości (GET :ns/quality —
 * lista checków wzorcem CheckList z preflight, zamiast dawnego „noGateReport"),
 * historia buildów per plik (GET :ns/jobs) na DataTable compact, wersja
 * schematu i typy dokumentów.
 */
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { t, formatDateTime, formatNumber } from '@/i18n/t';
import { Badge } from '@/ui/badge';
import { DataTable, type Column } from '@/ui/data-table';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Skeleton, SkeletonText } from '@/ui/skeleton';
import { CheckList, type CheckListItem } from './CheckList';
import { groupQualityChecks, qualityCheckLabelKey } from './kb-lib';
import { StatusBadgeV2 } from './StatusBadgeV2';
import { useQualityReport, verdictVariant } from './QualityCell';
import type { BuildJobItem, KbEntry, QualityCheckDto } from './types';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

function toItems(checks: readonly QualityCheckDto[]): CheckListItem[] {
  return checks.map((check, index) => ({
    id: `${check.id ?? 'check'}-${index}`,
    label: t(qualityCheckLabelKey(check.id ?? '')),
    message: check.details ?? '',
  }));
}

const JOB_COLUMNS: readonly Column<BuildJobItem & { key: string }>[] = [
  {
    key: 'name',
    header: t('kb.details.jobCol.name'),
    render: (job) => <span className="break-all">{job.name !== '' ? job.name : (job.fileUrl ?? '—')}</span>,
  },
  {
    key: 'status',
    header: t('kb.details.jobCol.status'),
    render: (job) => <StatusBadgeV2 status={job.status} label={job.statusLabel} />,
  },
  {
    key: 'date',
    header: t('kb.details.jobCol.date'),
    render: (job) => (
      <span className="text-text-secondary">
        {job.createdAt !== null ? formatDateTime(job.createdAt) : '—'}
      </span>
    ),
  },
];

function QualityReportSection({ namespace }: { namespace: string }) {
  const query = useQualityReport(namespace);
  const report = query.data?.report ?? null;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-text">{t('kb.details.gateReport')}</h3>
      {query.isPending ? (
        <SkeletonText lines={3} />
      ) : query.isError ? (
        <p className="text-sm text-text-secondary">{errorMessage(query.error)}</p>
      ) : report === null ? (
        <p className="text-sm text-text-secondary">{t('kb.details.noGateReport')}</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Badge variant={verdictVariant(report.verdict)} dot>
              {report.verdictLabel}
            </Badge>
            <span className="text-xs text-text-tertiary">
              {t('kb.quality.reportFrom', { date: formatDateTime(report.createdAt) })}
            </span>
          </div>
          {(() => {
            const groups = groupQualityChecks(report.checks);
            return (
              <div className="flex flex-col gap-4">
                <CheckList title={t('kb.build.blockers')} kind="fail" items={toItems(groups.failed)} />
                <CheckList title={t('kb.build.warnings')} kind="warn" items={toItems(groups.warned)} />
                <CheckList title={t('kb.build.passed')} kind="ok" items={toItems(groups.passed)} />
              </div>
            );
          })()}
        </>
      )}
    </section>
  );
}

export function KbDetailsSheet({ namespace, onClose }: { namespace: string | null; onClose: () => void }) {
  const detailQuery = useQuery({
    queryKey: ['kbs', namespace],
    queryFn: () => apiFetch<{ kb: KbEntry }>(`/api/v1/kbs/${namespace}`),
    enabled: namespace !== null,
  });
  const kb = detailQuery.data?.kb;

  const jobsQuery = useQuery({
    queryKey: ['kbs', namespace, 'jobs'],
    queryFn: () => apiFetch<{ items: BuildJobItem[] }>(`/api/v1/kbs/${namespace}/jobs?limit=50`),
    enabled: namespace !== null && kb !== undefined && kb.projectId !== null,
  });
  const jobs = (jobsQuery.data?.items ?? []).map((job, index) => ({
    ...job,
    key: String(job.id ?? `${job.name}-${index}`),
  }));

  return (
    <Sheet open={namespace !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" size="lg">
        <SheetHeader>
          <SheetTitle>{kb?.name ?? (namespace ?? '')}</SheetTitle>
          <SheetDescription>
            <code className="font-mono text-xs">{namespace ?? ''}</code>
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-5">
          {detailQuery.isLoading && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}
          {detailQuery.isError && <p className="text-sm text-fail">{errorMessage(detailQuery.error)}</p>}
          {kb !== undefined && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadgeV2 status={kb.status} />
                {kb.dirty && (
                  <Badge variant="warn">
                    <RefreshCw size={12} aria-hidden="true" />
                    {t('kb.dirtyChip')}
                  </Badge>
                )}
              </div>

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-text-secondary">{t('kb.details.description')}</dt>
                <dd className="text-text">
                  {kb.description !== '' ? (
                    kb.description
                  ) : (
                    <span className="text-text-tertiary">{t('kb.details.noDescription')}</span>
                  )}
                </dd>
                <dt className="text-text-secondary">{t('kb.col.project')}</dt>
                <dd>
                  {kb.projectId !== null ? (
                    <code className="font-mono text-xs">#{kb.projectId}</code>
                  ) : (
                    <span className="text-text-tertiary">{t('kb.noProject')}</span>
                  )}
                </dd>
                <dt className="text-text-secondary">{t('kb.details.schemaVersion')}</dt>
                <dd className="text-text">{kb.schemaVersion !== null ? `v${kb.schemaVersion}` : '—'}</dd>
                <dt className="text-text-secondary">{t('kb.details.vectorModel')}</dt>
                <dd>
                  {kb.vectorModelId !== '' ? (
                    <code className="break-all font-mono text-xs">{kb.vectorModelId}</code>
                  ) : (
                    <span className="text-text-tertiary">{t('kb.details.vectorModelMissing')}</span>
                  )}
                </dd>
                <dt className="text-text-secondary">{t('kb.col.totals')}</dt>
                <dd className="text-text">
                  {t('kb.totals.summary', {
                    docs: formatNumber(kb.totals.documents),
                    chunks: formatNumber(kb.totals.chunks),
                  })}
                </dd>
                <dt className="text-text-secondary">{t('kb.details.createdAt')}</dt>
                <dd className="text-text">{formatDateTime(kb.createdAt)}</dd>
                <dt className="text-text-secondary">{t('kb.details.updatedAt')}</dt>
                <dd className="text-text">{formatDateTime(kb.updatedAt)}</dd>
              </dl>

              <QualityReportSection namespace={kb.namespace} />

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-text">{t('kb.details.buildHistory')}</h3>
                {kb.projectId === null ? (
                  <p className="text-sm text-text-secondary">{t('kb.details.jobsUnavailable')}</p>
                ) : jobsQuery.isLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : jobsQuery.isError ? (
                  <p className="text-sm text-text-secondary">{errorMessage(jobsQuery.error)}</p>
                ) : jobs.length === 0 ? (
                  <p className="text-sm text-text-secondary">{t('kb.details.noJobs')}</p>
                ) : (
                  <DataTable columns={JOB_COLUMNS} rows={jobs} rowKey={(job) => job.key} density="compact" />
                )}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-text">{t('kb.details.documentTypes')}</h3>
                {kb.documentTypes.length === 0 ? (
                  <p className="text-sm text-text-secondary">{t('kb.details.noDocumentTypes')}</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {kb.documentTypes.map((docType) => (
                      <li key={docType.name}>
                        <span className="font-medium text-text">{docType.name}</span>
                        {docType.description !== '' && (
                          <span className="text-text-secondary"> — {docType.description}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
