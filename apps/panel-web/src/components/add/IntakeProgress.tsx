/**
 * Postęp aktywnego intake'u (polling GET /api/v1/content/:id co 2 s) —
 * Stepper LUDZKICH etapów z backendu; po sukcesie karta z CTA
 * (Inbox / Dodaj kolejną), auto-zwijana po 10 s (intake ląduje w
 * „Ostatnio dodane" z Badge ok).
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleCheck, Lightbulb } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { isIntakeTerminal, stagesToSteps } from '@/lib/intake';
import { t } from '@/i18n/t';
import { Stepper } from '@/components/Stepper';
import { Alert } from '@/ui/alert';
import { Button, buttonVariants } from '@/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { SkeletonText } from '@/ui/skeleton';
import type { IntakeDetail } from './types';

/** Po sukcesie karta znika sama po 10 s (plan: auto-zwijanie). */
const AUTO_COLLAPSE_MS = 10_000;

export interface IntakeProgressProps {
  intakeId: string;
  deduplicated: boolean;
  canInbox: boolean;
  /** „Dodaj kolejną" / retry po błędzie — czyści formularz i aktywny intake. */
  onAddAnother: () => void;
  /** Auto-zwijanie po sukcesie (strona chowa kartę → aside pokazuje Ostatnio dodane). */
  onCollapsed: () => void;
}

export function IntakeProgress({
  intakeId,
  deduplicated,
  canInbox,
  onAddAnother,
  onCollapsed,
}: IntakeProgressProps) {
  const query = useQuery({
    queryKey: ['content', intakeId],
    queryFn: () => apiFetch<{ intake: IntakeDetail }>(`/api/v1/content/${encodeURIComponent(intakeId)}`),
    refetchInterval: (q) => (isIntakeTerminal(q.state.data?.intake.status) ? false : 2000),
  });
  const intake = query.data?.intake;
  const drafted = intake?.status === 'drafted';

  useEffect(() => {
    if (!drafted) return;
    const handle = window.setTimeout(onCollapsed, AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(handle);
  }, [drafted, onCollapsed]);

  return (
    <Card aria-live="polite">
      <CardHeader>
        <CardTitle className="text-base">{t('add.progress.title')}</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {deduplicated && <Alert variant="info">{t('add.dedup')}</Alert>}
        {intake === undefined ? (
          <SkeletonText lines={4} />
        ) : (
          <>
            <Stepper steps={stagesToSteps(intake.stages, intake.status)} />
            {intake.status === 'failed' && (
              <div className="flex flex-col gap-2">
                <Alert variant="fail" title={intake.errorHuman?.label ?? intake.statusHuman.label}>
                  {intake.errorHuman?.description !== undefined && (
                    <p>{intake.errorHuman.description}</p>
                  )}
                  {/* Akcja naprawcza ze słownika komunikatów (soczewka product). */}
                  {intake.errorHuman?.action !== undefined && (
                    <p className="mt-1 flex items-start gap-1.5">
                      <Lightbulb size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                      {intake.errorHuman.action}
                    </p>
                  )}
                </Alert>
                <div>
                  <Button onClick={onAddAnother}>{t('common.retry')}</Button>
                </div>
              </div>
            )}
            {intake.status === 'drafted' && (
              <div className="flex flex-col gap-2 rounded-lg border border-ok/25 bg-ok-tint p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-text">
                  <CircleCheck size={16} className="shrink-0 text-ok" aria-hidden="true" />
                  {t('add.done.title')}
                </div>
                <p className="text-sm text-text-secondary">{t('add.done.description')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {canInbox && (
                    <Link
                      to="/inbox"
                      search={{}}
                      className={buttonVariants({ variant: 'primary', size: 'sm' })}
                    >
                      {t('add.done.inboxLink')}
                    </Link>
                  )}
                  <Button size="sm" onClick={onAddAnother}>
                    {t('add.done.again')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
