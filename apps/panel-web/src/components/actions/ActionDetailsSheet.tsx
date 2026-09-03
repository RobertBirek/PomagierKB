/**
 * Szczegóły akcji długobieżnej w Sheet (współdzielone: /settings zakładka
 * System oraz — przez deep-link — /overview). Postęp sparsowany na pasek
 * (percent/etap z progress_json jak ActionProgress), surowe dane w zwijanym
 * CodeBlocku, log w CodeBlocku z auto-scrollem na dół, Anuluj (running)
 * przez AlertDialog. Kontrakt: apps/panel-api/src/routes/actions.ts.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t, formatDateTime } from '@/i18n/t';
import { cn } from '@/ui/cn';
import { Alert } from '@/ui/alert';
import { AlertDialog } from '@/ui/alert-dialog';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { CodeBlock } from '@/ui/code-block';
import { SkeletonText } from '@/ui/skeleton';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/ui/sheet';
import { useToast } from '@/ui/toast';
import {
  actionProgressPercent,
  actionProgressStep,
  actionStatusVariant,
} from './actions-core';
import type { ActionDto } from './ActionsTable';

export interface ActionDetailsDto extends ActionDto {
  logTail: string[];
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

/** Pasek postępu akcji: percent → szerokość; running bez percent → indeterminate. */
function ProgressBar({ percent, running }: { percent: number | null; running: boolean }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent !== null ? { 'aria-valuenow': Math.round(percent) } : {})}
    >
      <div
        className={cn(
          'h-full rounded-full bg-accent transition-[width] duration-300',
          running && percent === null && 'animate-pulse',
        )}
        style={{ width: percent !== null ? `${percent}%` : running ? '40%' : '100%' }}
      />
    </div>
  );
}

export interface ActionDetailsSheetProps {
  actionId: string;
  onClose: () => void;
}

export function ActionDetailsSheet({ actionId, onClose }: ActionDetailsSheetProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const details = useQuery({
    queryKey: ['action', actionId],
    queryFn: () => apiFetch<ActionDetailsDto>(`/api/v1/actions/${actionId}`),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  const cancel = useMutation({
    mutationFn: () => apiFetch<ActionDto>(`/api/v1/actions/${actionId}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['action', actionId] });
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      setConfirmCancel(false);
      toast.show(t('system.actions.cancelSent'), 'ok');
    },
    onError: (err) => {
      setConfirmCancel(false);
      toast.show(errMsg(err), 'fail');
    },
  });

  const data = details.data;
  const logText = data !== undefined ? data.logTail.join('\n') : '';

  // Auto-scroll logu na dół po każdym doładowaniu linii (pre wewnątrz CodeBlock).
  const logWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const pre = logWrapRef.current?.querySelector('pre');
    if (pre !== null && pre !== undefined) pre.scrollTop = pre.scrollHeight;
  }, [logText]);

  const percent = data !== undefined ? actionProgressPercent(data.progress) : null;
  const step = data !== undefined ? actionProgressStep(data.progress) : null;
  const running = data?.status === 'running';

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" size="lg">
        <SheetHeader>
          <SheetTitle>{t('system.actions.detailsTitle', { id: actionId })}</SheetTitle>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4">
          {details.isPending && <SkeletonText lines={6} />}
          {details.isError && <Alert variant="fail">{errMsg(details.error)}</Alert>}
          {data !== undefined && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={actionStatusVariant(data.status)} dot>
                  {data.statusLabel}
                </Badge>
                <span className="text-sm text-text-secondary">{data.type}</span>
                {data.resource !== null && (
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text">
                    {data.resource}
                  </code>
                )}
              </div>

              <div className="text-xs text-text-secondary">
                {t('system.actions.startedAt')}: {formatDateTime(data.startedAt)}
                {data.startedBy !== null && <> · {t('system.actions.startedBy')}: {data.startedBy}</>}
                {data.finishedAt !== null && (
                  <>
                    {' · '}
                    {t('system.actions.finishedAt')}: {formatDateTime(data.finishedAt)}
                  </>
                )}
                {data.exitCode !== null && <> · {t('system.actions.exitCode', { code: data.exitCode })}</>}
              </div>

              {running && (
                <div>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={cancel.isPending}
                    onClick={() => setConfirmCancel(true)}
                  >
                    {t('system.actions.cancel')}
                  </Button>
                </div>
              )}

              {(data.progress !== null || running) && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium text-text">{t('system.actions.progress')}</span>
                    <span className="text-text-secondary">
                      {step !== null && <>{step} </>}
                      {percent !== null && <strong>{Math.round(percent)}%</strong>}
                    </span>
                  </div>
                  <ProgressBar percent={percent} running={running === true} />
                  {data.progress !== null && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-text-secondary hover:text-text">
                        {t('system.actions.progressRaw')}
                      </summary>
                      <div className="mt-1.5">
                        <CodeBlock
                          code={JSON.stringify(data.progress, null, 2)}
                          language="json"
                          maxHeight={200}
                        />
                      </div>
                    </details>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text">{t('system.actions.log')}</span>
                {data.logTail.length === 0 ? (
                  <p className="text-sm text-text-secondary">{t('system.actions.logEmpty')}</p>
                ) : (
                  <div ref={logWrapRef}>
                    <CodeBlock code={logText} maxHeight={280} label={t('system.actions.log')} />
                  </div>
                )}
              </div>
            </>
          )}
        </SheetBody>
      </SheetContent>

      <AlertDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={t('system.actions.cancelTitle')}
        {...(data !== undefined ? { objectName: `${data.type} · ${actionId}` } : {})}
        consequences={[t('system.actions.cancelC1')]}
        confirmLabel={t('system.actions.cancel')}
        destructive
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </Sheet>
  );
}
