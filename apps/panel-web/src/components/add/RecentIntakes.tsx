/**
 * „Ostatnio dodane" (GET /api/v1/content) — wiersze KLIKALNE: Sheet ze
 * szczegółami przetwarzania (Stepper etapów humanized z GET /content/:id);
 * failed → „Ponów" (prefill formularza robi strona), drafted → „Otwórz szkic"
 * (/inbox z q=tytuł).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileText, Lightbulb } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { stagesToSteps } from '@/lib/intake';
import { t, formatDateTime } from '@/i18n/t';
import { Stepper } from '@/components/Stepper';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button, buttonVariants } from '@/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { EmptyState } from '@/ui/empty-state';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/ui/sheet';
import { SkeletonText } from '@/ui/skeleton';
import { intakeBadgeVariant, type IntakeDetail, type IntakeListItem } from './types';

export interface RetryRequest {
  sourceKind: string;
  originalName: string | null;
}

export function RecentIntakes({ onRetry }: { onRetry: (req: RetryRequest) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['content-list'],
    queryFn: () => apiFetch<{ items: IntakeListItem[] }>('/api/v1/content'),
    staleTime: 10_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('add.recent.title')}</CardTitle>
      </CardHeader>
      <CardBody className="p-2">
        {query.isLoading && <SkeletonText lines={4} className="p-2" />}
        {query.isError && <p className="p-2 text-sm text-text-secondary">{t('common.error')}</p>}
        {query.data !== undefined &&
          (query.data.items.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={t('add.recent.empty.title')}
              description={t('add.recent.empty.description')}
              className="py-8"
            />
          ) : (
            <ul className="flex flex-col">
              {query.data.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-2"
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className="min-w-0 grow truncate text-sm text-text">
                      {item.originalName ?? t('add.recent.untitled')}
                    </span>
                    <Badge variant={intakeBadgeVariant(item.status)}>{item.statusHuman.label}</Badge>
                    <span className="shrink-0 text-xs text-text-secondary">
                      {formatDateTime(item.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </CardBody>

      <IntakeDetailSheet
        intakeId={selectedId}
        onClose={() => setSelectedId(null)}
        onRetry={(req) => {
          setSelectedId(null);
          onRetry(req);
        }}
      />
    </Card>
  );
}

function IntakeDetailSheet({
  intakeId,
  onClose,
  onRetry,
}: {
  intakeId: string | null;
  onClose: () => void;
  onRetry: (req: RetryRequest) => void;
}) {
  const detailQuery = useQuery({
    queryKey: ['content', intakeId],
    queryFn: () => apiFetch<{ intake: IntakeDetail }>(`/api/v1/content/${encodeURIComponent(intakeId ?? '')}`),
    enabled: intakeId !== null,
  });
  const intake = detailQuery.data?.intake;

  return (
    <Sheet open={intakeId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" size="md">
        <SheetHeader>
          <SheetTitle className="pr-4">
            {intake?.originalName ?? t('add.recent.detailsTitle')}
          </SheetTitle>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4">
          {detailQuery.isLoading && <SkeletonText lines={6} />}
          {detailQuery.isError && <Alert variant="fail">{t('common.error')}</Alert>}
          {intake !== undefined && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                <Badge variant={intakeBadgeVariant(intake.status)}>{intake.statusHuman.label}</Badge>
                <span>{formatDateTime(intake.createdAt)}</span>
              </div>
              <Stepper steps={stagesToSteps(intake.stages, intake.status)} />
              {intake.status === 'failed' && (
                <Alert variant="fail" title={intake.errorHuman?.label ?? intake.statusHuman.label}>
                  {intake.errorHuman?.description !== undefined && (
                    <p>{intake.errorHuman.description}</p>
                  )}
                  {intake.errorHuman?.action !== undefined && (
                    <p className="mt-1 flex items-start gap-1.5">
                      <Lightbulb size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                      {intake.errorHuman.action}
                    </p>
                  )}
                </Alert>
              )}
            </>
          )}
        </SheetBody>
        {intake !== undefined && (intake.status === 'failed' || intake.status === 'drafted') && (
          <SheetFooter>
            {intake.status === 'failed' && (
              <Button
                variant="primary"
                onClick={() => onRetry({ sourceKind: intake.sourceKind, originalName: intake.originalName })}
              >
                {t('add.recent.retry')}
              </Button>
            )}
            {intake.status === 'drafted' && (
              <Link
                to="/inbox"
                search={intake.originalName !== null ? { q: intake.originalName } : {}}
                className={buttonVariants({ variant: 'primary' })}
              >
                {t('add.recent.openDraft')}
              </Link>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
