/**
 * Zakładka „Konfiguracja" strony /backup — parametry NIESEKRETNE.
 *
 * Granica jest tu twarda i celowa: panel ustawia retencję, włącznik kopii off-site
 * i tryb miesięcznego snapshotu Neo4j, bo to decyzje operacyjne. NIE ustawia celu
 * wysyłki, poświadczeń rclone, klucza szyfrowania ani URL-i push-monitorów — te
 * zawierają sekrety i mieszkają w `/etc/kag/alerts.env` (0600, root). Panel nie ma
 * ich odczytać ani zapisać; pokazuje wyłącznie FAKT, że są skonfigurowane.
 *
 * Zapis idzie do SQLite (źródło prawdy), a stamtąd eksportem do pliku, który czytają
 * skrypty hosta — dlatego zmiana widoczna jest dopiero przy NASTĘPNYM biegu, i strona
 * mówi to wprost zamiast udawać natychmiastowość.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { t } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Card, CardBody, CardDescription, CardTitle } from '@/ui/card';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import { useToast } from '@/ui/toast';
import type { BackupConfigView } from './types';

const RANGE = {
  retentionDays: { min: 2, max: 365 },
  monthlyRetentionMonths: { min: 0, max: 120 },
} as const;

export function BackupConfigForm({ config }: { config: BackupConfigView }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<BackupConfigView>(config);

  const save = useMutation({
    mutationFn: (value: BackupConfigView) =>
      apiFetch<BackupConfigView>('/api/v1/backup/config', { method: 'PUT', body: value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['backup-state'] });
      toast.show(t('backup.config.saved'), 'ok');
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const dirty =
    draft.retentionDays !== config.retentionDays ||
    draft.monthlyRetentionMonths !== config.monthlyRetentionMonths ||
    draft.offsiteEnabled !== config.offsiteEnabled ||
    draft.coldNeo4jEnabled !== config.coldNeo4jEnabled;

  const valid =
    Number.isInteger(draft.retentionDays) &&
    draft.retentionDays >= RANGE.retentionDays.min &&
    draft.retentionDays <= RANGE.retentionDays.max &&
    Number.isInteger(draft.monthlyRetentionMonths) &&
    draft.monthlyRetentionMonths >= RANGE.monthlyRetentionMonths.min &&
    draft.monthlyRetentionMonths <= RANGE.monthlyRetentionMonths.max;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div>
            <CardTitle className="text-base">{t('backup.config.retentionTitle')}</CardTitle>
            <CardDescription className="mt-1">{t('backup.config.retentionDesc')}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-4">
            <Field label={t('backup.config.retentionDays')} className="w-44">
              <Input
                type="number"
                min={RANGE.retentionDays.min}
                max={RANGE.retentionDays.max}
                value={String(draft.retentionDays)}
                onChange={(ev) => setDraft({ ...draft, retentionDays: Number(ev.target.value) })}
              />
            </Field>
            <Field label={t('backup.config.monthlyMonths')} className="w-44">
              <Input
                type="number"
                min={RANGE.monthlyRetentionMonths.min}
                max={RANGE.monthlyRetentionMonths.max}
                value={String(draft.monthlyRetentionMonths)}
                onChange={(ev) => setDraft({ ...draft, monthlyRetentionMonths: Number(ev.target.value) })}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-4">
          <div>
            <CardTitle className="text-base">{t('backup.config.offsiteTitle')}</CardTitle>
            <CardDescription className="mt-1">{t('backup.config.offsiteDesc')}</CardDescription>
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={draft.offsiteEnabled}
              onCheckedChange={(checked) => setDraft({ ...draft, offsiteEnabled: checked === true })}
            />
            {t('backup.config.offsiteEnabled')}
          </label>
          {!draft.offsiteEnabled && (
            <Alert variant="warn" title={t('backup.config.offsiteOffTitle')}>
              {t('backup.config.offsiteOffBody')}
            </Alert>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-4">
          <div>
            <CardTitle className="text-base">{t('backup.config.coldTitle')}</CardTitle>
            <CardDescription className="mt-1">{t('backup.config.coldDesc')}</CardDescription>
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={draft.coldNeo4jEnabled}
              onCheckedChange={(checked) => setDraft({ ...draft, coldNeo4jEnabled: checked === true })}
            />
            {t('backup.config.coldEnabled')}
          </label>
        </CardBody>
      </Card>

      <Alert variant="info" title={t('backup.config.secretsTitle')}>
        {t('backup.config.secretsBody')}
      </Alert>

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          disabled={!dirty || !valid}
          loading={save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {t('common.save')}
        </Button>
        <span className="text-xs text-text-secondary">{t('backup.config.appliesNextRun')}</span>
      </div>
    </div>
  );
}
