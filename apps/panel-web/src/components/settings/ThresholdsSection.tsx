/**
 * Zakładka Progi (/settings): learning.threshold i answer.minScore — suwak
 * sprzężony z polem liczbowym, zapis z dirty-state i toast z akcją „Cofnij"
 * (PUT poprzedniej wartości — jedyne prawdziwe undo). Oba klucze są na białej
 * liście SETTINGS_KEYS backendu. Semantyka minScore ZMIENIŁA SIĘ po audycie 2026-09-06:
 * to minimalny COSINUS TRAFNOŚCI najlepszego wyniku (0.5–0.99), a nie znormalizowany
 * wynik zgodności kanałów — poprzednia bramka nigdy nie odrzucała (D8-01).
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { coerceNumberSetting } from '@/lib/settingsView';
import { t } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Card, CardBody, CardDescription, CardTitle } from '@/ui/card';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { SkeletonCard } from '@/ui/skeleton';
import { useToast } from '@/ui/toast';
import { useSettings, type MaskedSettingDto } from './LlmSection';

const LEARNING_THRESHOLD_DEFAULT = 0.45;
/**
 * Po audycie 2026-09-06 (D8-01) `answer.minScore` znaczy MINIMALNY COSINUS TRAFNOŚCI
 * najlepszego wyniku, a nie znormalizowany wynik zgodności kanałów — stara bramka była
 * matematycznie martwa i nigdy nie odrzucała. Backend (`resolveMinRelevance`) traktuje
 * wartości poniżej 0.5 jako „brak ustawienia" i używa 0.7, więc suwak nie może ich
 * oferować: pokazywałby stan, którego system nie honoruje.
 */
const ANSWER_MIN_SCORE_DEFAULT = 0.7;
const ANSWER_MIN_SCORE_RANGE = { min: 0.5, max: 0.99 } as const;
const LEARNING_THRESHOLD_RANGE = { min: 0, max: 1 } as const;

interface ThresholdCardProps {
  settingKey: 'learning.threshold' | 'answer.minScore';
  title: string;
  description: string;
  defaultValue: number;
  stored: number;
  min: number;
  max: number;
}

function ThresholdCard({
  settingKey,
  title,
  description,
  defaultValue,
  stored,
  min,
  max,
}: ThresholdCardProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<number | null>(null);

  const put = (value: number) =>
    apiFetch<MaskedSettingDto>(`/api/v1/settings/${settingKey}`, { method: 'PUT', body: { value } });

  const undo = useMutation({
    mutationFn: (previous: number) => put(previous),
    onSuccess: (_data, previous) => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      setDraft(null);
      toast.show(t('settings.thresholds.undone', { value: previous.toFixed(2) }), 'ok');
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const save = useMutation({
    mutationFn: (input: { value: number; previous: number }) => put(input.value),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      setDraft(null);
      toast.push({
        title: t('settings.thresholds.saved'),
        kind: 'ok',
        action: {
          label: t('settings.thresholds.undo'),
          onClick: () => undo.mutate(input.previous),
        },
      });
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const value = draft ?? stored;
  const dirty = draft !== null && draft !== stored;
  const inRange = value >= min && value <= max;

  function setValue(next: number): void {
    if (!Number.isFinite(next)) return;
    setDraft(Math.max(min, Math.min(max, next)));
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription className="mt-1">{description}</CardDescription>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <input
            className="min-w-40 grow accent-accent"
            type="range"
            min={min}
            max={max}
            step={0.01}
            value={value}
            aria-label={title}
            onChange={(ev) => setValue(Number(ev.target.value))}
          />
          <Field label={t('settings.thresholds.valueLabel')} className="w-28">
            <Input
              type="number"
              min={min}
              max={max}
              step={0.01}
              value={String(value)}
              onChange={(ev) => setValue(Number(ev.target.value))}
            />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={!dirty || !inRange}
            loading={save.isPending}
            onClick={() => {
              if (draft !== null) save.mutate({ value: draft, previous: stored });
            }}
          >
            {t('common.save')}
          </Button>
          <span className="text-xs text-text-secondary">
            {t('settings.thresholds.default', { value: defaultValue })}
          </span>
        </div>
      </CardBody>
    </Card>
  );
}

export function ThresholdsSection() {
  const settings = useSettings();

  if (settings.isPending) return <SkeletonCard />;
  if (settings.isError) {
    return (
      <Alert variant="fail" title={t('common.error')}>
        {errorMessage(settings.error)}
      </Alert>
    );
  }

  const learningStored = coerceNumberSetting(
    settings.data['learning.threshold']?.value,
    LEARNING_THRESHOLD_DEFAULT,
  );
  const minScoreStored = coerceNumberSetting(
    settings.data['answer.minScore']?.value,
    ANSWER_MIN_SCORE_DEFAULT,
  );

  return (
    <div className="flex flex-col gap-3">
      <ThresholdCard
        settingKey="learning.threshold"
        title={t('settings.thresholds.learningTitle')}
        description={t('settings.thresholds.learningDesc')}
        defaultValue={LEARNING_THRESHOLD_DEFAULT}
        stored={learningStored}
        min={LEARNING_THRESHOLD_RANGE.min}
        max={LEARNING_THRESHOLD_RANGE.max}
      />
      <ThresholdCard
        settingKey="answer.minScore"
        title={t('settings.thresholds.minScoreTitle')}
        description={t('settings.thresholds.minScoreDesc')}
        defaultValue={ANSWER_MIN_SCORE_DEFAULT}
        stored={minScoreStored}
        min={ANSWER_MIN_SCORE_RANGE.min}
        max={ANSWER_MIN_SCORE_RANGE.max}
      />
    </div>
  );
}
