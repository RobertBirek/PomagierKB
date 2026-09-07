/**
 * Zakładka „Stan" strony /backup: trzy werdykty (backup / weryfikacja odtwarzania /
 * kopia off-site), szczegóły ostatniego biegu, harmonogram timerów i przyciski wyzwalania.
 *
 * Trzy werdykty, a nie jeden „backup działa", bo to trzy NIEZALEŻNE sposoby, na które
 * ten łańcuch potrafi zawieść, i każdy z nich zdarzył się tu naprawdę: snapshot
 * niekompletny mimo zielonego biegu (2026-09-03), weryfikacja czerwona przez cztery dni
 * bez reakcji (2026-09-06) i brak kopii poza hostem (do 2026-09-07). Jeden agregat
 * ukryłby dwa z nich.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, CalendarClock, CloudUpload, HardDrive, PlayCircle, ShieldCheck } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { formatBytes, formatStamp, verdictTone, verdictVariant } from '@/lib/backup';
import { t, formatDateTime } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { MetricTile } from '@/ui/metric-tile';
import { useToast } from '@/ui/toast';
import type { BackupStateResponse } from './types';

const TIMER_LABEL: Record<string, string> = {
  'kag-backup.timer': 'Snapshot nocny',
  'kag-backup-verify.timer': 'Weryfikacja odtwarzania',
  'kag-backup-cold.timer': 'Snapshot zimny (Neo4j zatrzymany)',
};

function RunTrigger({ state }: { state: BackupStateResponse }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const run = useMutation({
    mutationFn: (kind: 'backup' | 'verify') =>
      apiFetch('/api/v1/backup/run', { method: 'POST', body: { kind } }),
    onSuccess: (_data, kind) => {
      void queryClient.invalidateQueries({ queryKey: ['backup-state'] });
      toast.show(t(kind === 'backup' ? 'backup.run.queuedBackup' : 'backup.run.queuedVerify'), 'ok');
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  // Przycisk nie może obiecywać czegoś, czego host nie obsłuży: gdy jednostka .path nie
  // jest aktywna, znacznik nikt nie odbierze i żądanie po cichu utknie.
  if (!(state.state?.triggerSupported ?? false)) {
    return (
      <Alert variant="info" title={t('backup.run.unavailableTitle')}>
        {t('backup.run.unavailableBody')}
      </Alert>
    );
  }

  const busy = run.isPending || state.requestPending;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" loading={run.isPending} disabled={busy} onClick={() => run.mutate('backup')}>
        <PlayCircle size={16} aria-hidden="true" />
        {t('backup.run.backup')}
      </Button>
      <Button variant="secondary" disabled={busy} onClick={() => run.mutate('verify')}>
        <ShieldCheck size={16} aria-hidden="true" />
        {t('backup.run.verify')}
      </Button>
      <span className="text-xs text-text-secondary">
        {state.requestPending ? t('backup.run.pending') : t('backup.run.hint')}
      </span>
    </div>
  );
}

export function BackupStatusCards({ state }: { state: BackupStateResponse }) {
  const { verdicts } = state;
  const last = state.state?.last ?? null;
  const verify = state.state?.verify ?? null;
  const failedChecks = verify?.checks.filter((c) => !c.ok) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {state.state === null && (
        <Alert variant="warn" title={t('backup.state.missingTitle')}>{t('backup.state.missingBody')}</Alert>
      )}
      {state.stale && (
        <Alert variant="warn" title={t('backup.state.staleTitle')}>
          {t('backup.state.staleBody', {
            when: state.state?.generatedAt !== null && state.state?.generatedAt !== undefined
              ? formatDateTime(state.state.generatedAt)
              : '—',
          })}
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label={t('backup.tile.lastBackup')}
          value={last?.stamp !== null && last?.stamp !== undefined ? formatStamp(last.stamp) : '—'}
          hint={verdicts.backup.detail}
          icon={Archive}
          tone={verdictTone(verdicts.backup.verdict)}
        />
        <MetricTile
          label={t('backup.tile.verify')}
          value={
            verify?.checkedAt !== null && verify?.checkedAt !== undefined
              ? formatDateTime(verify.checkedAt)
              : '—'
          }
          hint={verdicts.verify.detail}
          icon={ShieldCheck}
          tone={verdictTone(verdicts.verify.verdict)}
        />
        <MetricTile
          label={t('backup.tile.offsite')}
          value={last?.offsite.status ?? '—'}
          hint={verdicts.offsite.detail}
          icon={CloudUpload}
          tone={verdictTone(verdicts.offsite.verdict)}
        />
        <MetricTile
          label={t('backup.tile.disk')}
          value={formatBytes(state.state?.disk.freeBytes ?? null)}
          hint={t('backup.tile.diskHint', {
            used: state.state?.disk.usedPercent ?? '—',
            snapshots: state.state?.snapshots.length ?? 0,
          })}
          icon={HardDrive}
        />
      </div>

      {last !== null && last.ok === false && (
        <Alert variant="fail" title={t('backup.alert.incompleteTitle')}>
          {t('backup.alert.incompleteBody', { missing: last.missingRequired.join(', ') || '—' })}
        </Alert>
      )}
      {failedChecks.length > 0 && (
        <Alert variant="fail" title={t('backup.alert.verifyFailedTitle')}>
          <ul className="mt-1 list-disc pl-5">
            {failedChecks.map((c) => (
              <li key={c.name}>
                <span className="font-medium">{c.name}</span>
                {c.detail !== null && <span className="text-text-secondary"> — {c.detail}</span>}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {(last?.warnings.length ?? 0) > 0 && (
        <Alert variant="warn" title={t('backup.alert.warningsTitle')}>
          <ul className="mt-1 list-disc pl-5">
            {last?.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PlayCircle size={16} aria-hidden="true" />
            {t('backup.run.title')}
          </CardTitle>
        </CardHeader>
        <CardBody>
          <RunTrigger state={state} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock size={16} aria-hidden="true" />
            {t('backup.schedule.title')}
          </CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          {(state.state?.timers.length ?? 0) === 0 && (
            <p className="text-sm text-text-secondary">{t('backup.schedule.empty')}</p>
          )}
          {state.state?.timers.map((timer) => (
            <div key={timer.unit} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2">
                <Badge variant={timer.enabled === true ? 'ok' : 'fail'} tone="outline">
                  {timer.enabled === true ? t('backup.schedule.enabled') : t('backup.schedule.disabled')}
                </Badge>
                <span className="font-medium">{TIMER_LABEL[timer.unit] ?? timer.unit}</span>
              </span>
              <span className="text-text-secondary">
                {t('backup.schedule.nextLast', {
                  next: timer.next !== null ? formatDateTime(timer.next) : '—',
                  last: timer.last !== null ? formatDateTime(timer.last) : '—',
                })}
              </span>
            </div>
          ))}
          <p className="mt-1 text-xs text-text-secondary">
            {t('backup.schedule.pingHint', {
              backup: state.state?.config.pingBackupConfigured === true ? t('common.yes') : t('common.no'),
              verify: state.state?.config.pingVerifyConfigured === true ? t('common.yes') : t('common.no'),
            })}
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CloudUpload size={16} aria-hidden="true" />
            {t('backup.offsite.title')}
          </CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={verdictVariant(verdicts.offsite.verdict)}>{verdicts.offsite.detail}</Badge>
          </div>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <div>
              <dt className="text-text-secondary">{t('backup.offsite.target')}</dt>
              <dd className="break-all">{state.state?.config.offsiteTarget ?? t('backup.offsite.noTarget')}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">{t('backup.offsite.encryption')}</dt>
              <dd>{state.state?.config.encryption ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">{t('backup.offsite.artifact')}</dt>
              <dd className="break-all">{last?.offsite.artifact ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">{t('backup.offsite.rclone')}</dt>
              <dd>{state.state?.config.rcloneRemotes.join(', ') || t('backup.offsite.noRclone')}</dd>
            </div>
          </dl>
          <p className="text-xs text-text-secondary">{t('backup.offsite.secretsHint')}</p>
        </CardBody>
      </Card>
    </div>
  );
}
