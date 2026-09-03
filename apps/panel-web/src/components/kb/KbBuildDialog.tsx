/**
 * Dialog builda KB: preflight (POST :ns/preflight — dry-run) → grupy checków;
 * przy OSTRZEŻENIACH przycisk startu aktywny dopiero po zaznaczeniu
 * „Rozumiem ostrzeżenia"; blokady wyłączają start. Start = POST :ns/build
 * (202+actionId) → ActionProgress w tym samym dialogu.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { groupPreflightChecks, preflightCheckLabelKey, type PreflightCheck } from '@/lib/preflight';
import { statusLabel } from '@/lib/status';
import { t } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Skeleton } from '@/ui/skeleton';
import { useToast } from '@/ui/toast';
import { ActionProgress } from '../ActionProgress';
import type { ActionState } from '@/hooks/useAction';
import { CheckList } from './CheckList';
import type { KbEntry, LaunchedAction } from './types';

interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

const toItems = (checks: readonly PreflightCheck[]) =>
  checks.map((check) => ({ id: check.id, label: t(preflightCheckLabelKey(check.id)), message: check.message }));

export function KbBuildDialog({ kb, onClose }: { kb: KbEntry | null; onClose: () => void }) {
  const toast = useToast();
  const [actionId, setActionId] = useState<string | null>(null);
  const [ackWarnings, setAckWarnings] = useState(false);

  useEffect(() => {
    setActionId(null);
    setAckWarnings(false);
  }, [kb?.namespace]);

  // Preflight to dry-run bez mutacji — POST tylko ze względu na CSRF/rate-limit.
  const preflightQuery = useQuery({
    queryKey: ['kb-preflight', kb?.namespace],
    queryFn: () => apiFetch<PreflightResult>(`/api/v1/kbs/${kb?.namespace}/preflight`, { method: 'POST' }),
    enabled: kb !== null,
    staleTime: 0,
    gcTime: 0,
  });

  const build = useMutation({
    mutationFn: (namespace: string) =>
      apiFetch<Partial<LaunchedAction>>(`/api/v1/kbs/${namespace}/build`, { method: 'POST' }),
    onSuccess: (data) => {
      toast.show(t('kb.build.started'), 'ok');
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      if (typeof data.actionId === 'string') {
        setActionId(data.actionId);
      } else {
        onClose();
      }
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const groups = preflightQuery.data !== undefined ? groupPreflightChecks(preflightQuery.data.checks) : null;
  const hasWarnings = groups !== null && groups.warnings.length > 0;
  const blocked =
    groups === null || groups.blockers.length > 0 || (hasWarnings && !ackWarnings);

  const onBuildFinished = (state: ActionState): void => {
    void queryClient.invalidateQueries({ queryKey: ['kbs'] });
    void queryClient.invalidateQueries({ queryKey: ['actions'] });
    toast.show(
      t('kb.build.finished', { status: statusLabel(state.status) }),
      state.status === 'success' ? 'ok' : 'fail',
    );
  };

  return (
    <Dialog open={kb !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{kb !== null ? t('kb.build.modalTitle', { name: kb.name }) : ''}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {actionId !== null ? (
            <ActionProgress actionId={actionId} onFinished={onBuildFinished} />
          ) : preflightQuery.isLoading ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-secondary">{t('kb.build.preflightRunning')}</p>
              <Skeleton className="h-20 w-full" />
            </div>
          ) : preflightQuery.isError ? (
            <div className="flex flex-col items-start gap-3">
              <Alert variant="fail">
                {t('kb.build.preflightError', { message: errorMessage(preflightQuery.error) })}
              </Alert>
              <Button onClick={() => void preflightQuery.refetch()}>{t('common.retry')}</Button>
            </div>
          ) : groups !== null ? (
            <div className="flex flex-col gap-4">
              <CheckList title={t('kb.build.blockers')} kind="fail" items={toItems(groups.blockers)} />
              <CheckList title={t('kb.build.warnings')} kind="warn" items={toItems(groups.warnings)} />
              <CheckList title={t('kb.build.passed')} kind="ok" items={toItems(groups.passed)} />
              {hasWarnings && groups.blockers.length === 0 && (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
                  <Checkbox
                    checked={ackWarnings}
                    onCheckedChange={(checked) => setAckWarnings(checked === true)}
                  />
                  {t('kb.build.ackWarnings')}
                </label>
              )}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {actionId === null ? (
            <>
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                disabled={blocked}
                loading={build.isPending}
                onClick={() => kb !== null && build.mutate(kb.namespace)}
              >
                {hasWarnings ? t('kb.build.startDespiteWarnings') : t('kb.build.start')}
              </Button>
            </>
          ) : (
            <Button onClick={onClose}>{t('common.close')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
