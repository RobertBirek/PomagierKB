/**
 * Zakładka Health (/settings): tabela komponentów cockpitu (useStatus) +
 * tabela breakerów z resetem przez AlertDialog warn ({reason} w konsekwencji);
 * „stan z {at}" + ręczne odświeżenie. Kontrakt: apps/panel-api/src/routes/status.ts
 * (cache 10 s po stronie backendu).
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useStatus } from '@/hooks/useStatus';
import { t, formatDateTime, type PlKey } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { AlertDialog } from '@/ui/alert-dialog';
import { Badge } from '@/ui/badge';
import { Button, IconButton } from '@/ui/button';
import { Card, CardBody } from '@/ui/card';
import { DataTable, type Column } from '@/ui/data-table';
import { SkeletonCard } from '@/ui/skeleton';
import { useToast } from '@/ui/toast';

interface BreakerDto {
  name: string;
  state: string;
  reason?: string | null;
  retryAfter?: string | null;
}

interface ComponentRow {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'down' | 'unknown';
  detail: string;
  latencyMs: number;
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

const COMPONENT_BADGE: Record<ComponentRow['status'], { variant: 'ok' | 'warn' | 'fail' | 'neutral'; labelKey: PlKey }> = {
  ok: { variant: 'ok', labelKey: 'status.ok' },
  warn: { variant: 'warn', labelKey: 'status.warn' },
  down: { variant: 'fail', labelKey: 'status.down' },
  unknown: { variant: 'neutral', labelKey: 'status.unknown' },
};

function breakerBadge(state: string): { variant: 'ok' | 'warn' | 'fail'; labelKey: PlKey } {
  if (state === 'open') return { variant: 'fail', labelKey: 'system.breakers.stateOpen' };
  if (state === 'half_open') return { variant: 'warn', labelKey: 'system.breakers.stateHalfOpen' };
  return { variant: 'ok', labelKey: 'system.breakers.stateClosed' };
}

export function HealthSection() {
  const status = useStatus();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [resetTarget, setResetTarget] = useState<BreakerDto | null>(null);

  const reset = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ breakers: BreakerDto[] }>(`/api/v1/status/breakers/${encodeURIComponent(name)}/reset`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      setResetTarget(null);
      toast.show(t('system.breakers.resetDone'), 'ok');
    },
    onError: (err) => {
      setResetTarget(null);
      toast.show(errMsg(err), 'fail');
    },
  });

  if (status.isPending) return <SkeletonCard />;
  if (status.isError || status.data === undefined) {
    return <Alert variant="fail">{errMsg(status.error)}</Alert>;
  }

  const cockpit = status.data;
  const breakers = (cockpit.breakers ?? []) as BreakerDto[];

  const componentColumns: readonly Column<ComponentRow>[] = [
    { key: 'label', header: t('system.health.component'), render: (c) => c.label },
    {
      key: 'status',
      header: t('system.actions.status'),
      render: (c) => {
        const badge = COMPONENT_BADGE[c.status];
        return (
          <Badge variant={badge.variant} dot>
            {t(badge.labelKey)}
          </Badge>
        );
      },
    },
    {
      key: 'detail',
      header: t('system.health.detail'),
      hideBelow: 'sm',
      render: (c) => <span className="text-text-secondary">{c.detail}</span>,
    },
    {
      key: 'latency',
      header: t('system.health.latency'),
      align: 'right',
      hideBelow: 'md',
      render: (c) => `${c.latencyMs} ms`,
    },
  ];

  const breakerColumns: readonly Column<BreakerDto>[] = [
    { key: 'name', header: t('system.breakers.name'), render: (b) => <code className="font-mono text-xs">{b.name}</code> },
    {
      key: 'state',
      header: t('system.breakers.state'),
      render: (b) => {
        const badge = breakerBadge(b.state);
        return (
          <Badge variant={badge.variant} dot>
            {t(badge.labelKey)}
          </Badge>
        );
      },
    },
    {
      key: 'reason',
      header: t('system.breakers.reason'),
      hideBelow: 'sm',
      render: (b) => <span className="text-text-secondary">{b.reason ?? '—'}</span>,
    },
    {
      key: 'retryAfter',
      header: t('system.breakers.retryAfter'),
      hideBelow: 'md',
      render: (b) =>
        b.retryAfter !== null && b.retryAfter !== undefined ? formatDateTime(b.retryAfter) : '—',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (b) =>
        b.state !== 'closed' ? (
          <Button size="sm" onClick={() => setResetTarget(b)}>
            {t('system.breakers.reset')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text">{t('system.health.title')}</h3>
          <Badge variant={COMPONENT_BADGE[cockpit.overall].variant} dot>
            {t(COMPONENT_BADGE[cockpit.overall].labelKey)}
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span>{t('system.health.generatedAt', { at: formatDateTime(cockpit.generatedAt) })}</span>
          <IconButton
            aria-label={t('system.health.refresh')}
            loading={status.isFetching}
            onClick={() => void status.refetch()}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      <Card>
        <CardBody className="p-0 px-1">
          <DataTable columns={componentColumns} rows={cockpit.components} rowKey={(c) => c.id} />
        </CardBody>
      </Card>

      <h3 className="mt-2 text-sm font-semibold text-text">{t('system.breakers.title')}</h3>
      {breakers.length === 0 ? (
        <Alert variant="ok">{t('system.breakers.emptyDesc')}</Alert>
      ) : (
        <Card>
          <CardBody className="p-0 px-1">
            <DataTable columns={breakerColumns} rows={breakers} rowKey={(b) => b.name} />
          </CardBody>
        </Card>
      )}

      <AlertDialog
        open={resetTarget !== null}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
        title={t('system.breakers.resetTitle')}
        {...(resetTarget !== null ? { objectName: resetTarget.name } : {})}
        consequences={[
          t('system.breakers.resetC1'),
          t('system.breakers.resetC2', { reason: resetTarget?.reason ?? '—' }),
        ]}
        confirmLabel={t('system.breakers.resetConfirm')}
        loading={reset.isPending}
        onConfirm={() => {
          if (resetTarget !== null) reset.mutate(resetTarget.name);
        }}
      />
    </div>
  );
}
