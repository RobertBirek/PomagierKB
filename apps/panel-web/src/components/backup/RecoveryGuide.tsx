/**
 * Zakładki „Snapshoty" i „Odtwarzanie" strony /backup.
 *
 * Odtwarzanie NIE MA tu przycisku i mieć nie będzie. `restore.sh` zatrzymuje oba stacki
 * i nadpisuje wszystkie magazyny naraz — jedno kliknięcie w przeglądarce (przez pomyłkę,
 * przez cudzą sesję, przez podwójny klik) kosztowałoby cały stan produkcyjny. Panel robi
 * więc rzecz, którą robi dobrze: pokazuje, KTÓRY snapshot wybrać i podaje dokładne
 * komendy dla wybranego stempla, gotowe do skopiowania. Wykonuje je człowiek na hoście.
 *
 * Komendy są składane z realnych danych (`lib/backup.ts`), a nie przepisane z runbooka —
 * runbook DR mylił się już co do nazw plików w snapshocie i nikt tego nie zauważył,
 * dopóki nie przyszedł audyt.
 */
import { useState } from 'react';
import { Snowflake, Star } from 'lucide-react';
import { formatBytes, formatStamp, recoverySteps, shouldRemindAboutKeyCustody } from '@/lib/backup';
import { t } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { CodeBlock } from '@/ui/code-block';
import { DataTable, type Column } from '@/ui/data-table';
import { EmptyState } from '@/ui/empty-state';
import { Select } from '@/ui/select';
import type { BackupSnapshotView, BackupStateResponse } from './types';

export function SnapshotsTable({ state }: { state: BackupStateResponse }) {
  const snapshots = state.state?.snapshots ?? [];
  if (snapshots.length === 0) {
    return <EmptyState title={t('backup.snapshots.emptyTitle')} description={t('backup.snapshots.emptyBody')} />;
  }

  const columns: Column<BackupSnapshotView>[] = [
    {
      key: 'stamp',
      header: t('backup.snapshots.colWhen'),
      render: (row: BackupSnapshotView) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{formatStamp(row.stamp)}</span>
          {row.monthly && (
            <Badge variant="accent" tone="outline">
              <Star size={12} aria-hidden="true" />
              {t('backup.snapshots.monthly')}
            </Badge>
          )}
          {row.neo4jMode === 'cold' && (
            <Badge variant="info" tone="outline">
              <Snowflake size={12} aria-hidden="true" />
              {t('backup.snapshots.cold')}
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'ok',
      header: t('backup.snapshots.colState'),
      render: (row: BackupSnapshotView) =>
        row.ok === true ? (
          <Badge variant="ok">{t('backup.snapshots.complete')}</Badge>
        ) : row.ok === false ? (
          <Badge variant="fail">{t('backup.snapshots.incomplete')}</Badge>
        ) : (
          <Badge variant="neutral">{t('backup.snapshots.unknown')}</Badge>
        ),
    },
    { key: 'sizeBytes', header: t('backup.snapshots.colSize'), render: (row: BackupSnapshotView) => formatBytes(row.sizeBytes) },
    { key: 'raw', header: t('backup.snapshots.colStamp'), render: (row: BackupSnapshotView) => <code className="text-xs">{row.stamp}</code> },
  ];

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('backup.snapshots.title')}</CardTitle>
          <CardDescription>
            {t('backup.snapshots.desc', {
              days: state.config.retentionDays,
              months: state.config.monthlyRetentionMonths,
            })}
          </CardDescription>
        </CardHeader>
        <CardBody>
          <DataTable columns={columns} rows={snapshots} rowKey={(row) => row.stamp} />
        </CardBody>
      </Card>
    </div>
  );
}

export function RecoveryGuide({ state }: { state: BackupStateResponse }) {
  const snapshots = state.state?.snapshots ?? [];
  // Domyślnie najnowszy KOMPLETNY — odtwarzanie z niekompletnego to najdroższy możliwy
  // błąd, więc domyślny wybór nie może na niego wskazywać.
  const [selected, setSelected] = useState<string>(
    snapshots.find((s) => s.ok === true)?.stamp ?? snapshots[0]?.stamp ?? '',
  );
  const snapshot = snapshots.find((s) => s.stamp === selected) ?? null;
  const last = state.state?.last ?? null;

  const steps = recoverySteps({
    stamp: snapshot?.stamp ?? null,
    // Artefakt off-site znamy tylko dla OSTATNIEGO biegu — manifesty starszych snapshotów
    // też go mają, ale panel ich nie widzi. Dla starszego stempla nazwę wyprowadzamy
    // z konwencji, bo taka właśnie jest: `<stempel>.tar.<szyfr>`.
    offsiteArtifact:
      snapshot === null
        ? null
        : snapshot.stamp === last?.stamp
          ? last.offsite.artifact
          : state.state?.config.encryption !== null && state.state?.config.encryption !== undefined &&
              state.state.config.encryption !== 'none'
            ? `${snapshot.stamp}.tar.${state.state.config.encryption}`
            : null,
    offsiteTarget: state.state?.config.offsiteTarget ?? null,
    encryption: state.state?.config.encryption ?? null,
  });

  return (
    <div className="flex flex-col gap-3">
      <Alert variant="warn" title={t('backup.recovery.noButtonTitle')}>
        {t('backup.recovery.noButtonBody')}
      </Alert>

      {shouldRemindAboutKeyCustody(
        state.state?.config.encryption ?? null,
        last?.offsite.status ?? null,
      ) && (
        <Alert variant="info" title={t('backup.recovery.keyCustodyTitle')}>
          {t('backup.recovery.keyCustodyBody')}
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('backup.recovery.pickTitle')}</CardTitle>
          <CardDescription>{t('backup.recovery.pickDesc')}</CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {snapshots.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('backup.snapshots.emptyBody')}</p>
          ) : (
            <Select value={selected} onChange={(ev) => setSelected(ev.target.value)} className="max-w-md">
              {snapshots.map((s) => (
                <option key={s.stamp} value={s.stamp}>
                  {formatStamp(s.stamp)}
                  {s.ok === true ? '' : ` — ${t('backup.snapshots.incomplete')}`}
                  {s.neo4jMode === 'cold' ? ` — ${t('backup.snapshots.cold')}` : ''}
                </option>
              ))}
            </Select>
          )}
          {snapshot !== null && snapshot.ok !== true && (
            <Alert variant="fail" title={t('backup.recovery.incompletePickTitle')}>
              {t('backup.recovery.incompletePickBody')}
            </Alert>
          )}
        </CardBody>
      </Card>

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.title}>
            <Card>
              <CardBody className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <Badge variant="neutral" tone="outline">
                    {index + 1}
                  </Badge>
                  <span className="font-medium text-text">{step.title}</span>
                </div>
                {step.note !== undefined && <p className="text-sm text-text-secondary">{step.note}</p>}
                <CodeBlock code={step.command} language="bash" />
              </CardBody>
            </Card>
          </li>
        ))}
      </ol>

      <Alert variant="info" title={t('backup.recovery.runbookTitle')}>
        {t('backup.recovery.runbookBody')}
      </Alert>
    </div>
  );
}
