/**
 * Zakładka LLM (/settings): 3 kompaktowe rzędy celów (chat/openie/embeddings)
 * z Badge konfiguracji, testem połączenia inline i edycją w Dialogu.
 * Nadpisanie istniejącego sekretu przechodzi przez AlertDialog (preview
 * starego klucza). Embeddingi przy ≥1 aktywnej KB — zablokowane (Badge Lock
 * + Alert, bez formularza). Kontrakt: apps/panel-api/src/routes/settings.ts.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { maskSecret } from '@/lib/settingsView';
import { t, formatDateTime, type PlKey } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { AlertDialog } from '@/ui/alert-dialog';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardBody } from '@/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { SkeletonCard } from '@/ui/skeleton';
import { useToast } from '@/ui/toast';

export interface MaskedSettingDto {
  configured: boolean;
  /** Tylko sekrety: zamaskowany podgląd (np. 'ab***yz'), nigdy pełna wartość. */
  preview?: string;
  /** Tylko ustawienia jawne: pełna wartość. */
  value?: unknown;
  updatedAt?: string;
  updatedBy?: string | null;
}

export type SettingsMap = Record<string, MaskedSettingDto | undefined>;

interface TestLlmResult {
  ok: boolean;
  model: string;
  latencyMs: number;
}

type LlmTarget = 'chat' | 'openie' | 'embeddings';

const TARGETS: { target: LlmTarget; titleKey: PlKey; descKey: PlKey }[] = [
  { target: 'chat', titleKey: 'settings.llm.chatTitle', descKey: 'settings.llm.chatDesc' },
  { target: 'openie', titleKey: 'settings.llm.openieTitle', descKey: 'settings.llm.openieDesc' },
  { target: 'embeddings', titleKey: 'settings.llm.embeddingsTitle', descKey: 'settings.llm.embeddingsDesc' },
];

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

/** Kliencka walidacja adresu API: http(s):// + poprawny URL. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => apiFetch<SettingsMap>('/api/v1/settings') });
}

/** Dialog konfiguracji jednego celu LLM + AlertDialog nadpisania sekretu. */
function LlmEditDialog({
  target,
  titleKey,
  setting,
  onClose,
}: {
  target: LlmTarget;
  titleKey: PlKey;
  setting: MaskedSettingDto | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [urlTouched, setUrlTouched] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const configured = setting?.configured === true;
  const urlInvalid = baseUrl.trim() !== '' && !isHttpUrl(baseUrl.trim());
  const canSave = baseUrl.trim() !== '' && !urlInvalid && model.trim() !== '';

  const save = useMutation({
    mutationFn: () =>
      apiFetch<MaskedSettingDto>(`/api/v1/settings/llm.${target}`, {
        method: 'PUT',
        body: { value: { baseUrl: baseUrl.trim(), model: model.trim(), apiKey } },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      setConfirmOverwrite(false);
      toast.show(t('settings.llm.saved'), 'ok');
      onClose();
    },
    onError: (err) => {
      setConfirmOverwrite(false);
      toast.show(errMsg(err), 'fail');
    },
  });

  function onSaveClick(): void {
    if (!canSave) return;
    // Nadpisanie ISTNIEJĄCEGO klucza nowym sekretem → potwierdzenie z preview.
    if (apiKey !== '' && configured) {
      setConfirmOverwrite(true);
      return;
    }
    save.mutate();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
          <DialogDescription>{t('settings.llm.overwriteHint')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Field
            label={t('settings.llm.baseUrl')}
            required
            {...(urlTouched && urlInvalid ? { error: t('settings.llm.invalidUrl') } : {})}
          >
            <Input
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(ev) => setBaseUrl(ev.target.value)}
              onBlur={() => setUrlTouched(true)}
            />
          </Field>
          <Field label={t('settings.llm.model')} required>
            <Input value={model} onChange={(ev) => setModel(ev.target.value)} />
          </Field>
          <Field
            label={t('settings.llm.apiKey')}
            hint={
              apiKey !== ''
                ? t('settings.llm.willSaveAs', { preview: maskSecret(apiKey) })
                : t('settings.llm.keyKeepHint')
            }
          >
            <Input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder={configured ? t('settings.llm.keyKeepHint') : ''}
              onChange={(ev) => setApiKey(ev.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t('ui.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!canSave}
            loading={save.isPending && !confirmOverwrite}
            title={canSave ? undefined : t('settings.llm.requiredHint')}
            onClick={onSaveClick}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>

      <AlertDialog
        open={confirmOverwrite}
        onOpenChange={setConfirmOverwrite}
        title={t('settings.llm.overwriteTitle')}
        objectName={`llm.${target}`}
        consequences={[
          t('settings.llm.overwriteC1', { preview: setting?.preview ?? '***' }),
          t('settings.llm.overwriteC2'),
        ]}
        confirmLabel={t('settings.llm.overwriteConfirm')}
        destructive
        loading={save.isPending}
        onConfirm={() => save.mutate()}
      />
    </Dialog>
  );
}

/** Kompaktowy rząd jednego celu LLM: Badge konfiguracji + Testuj + Konfiguruj. */
function LlmRow({
  target,
  titleKey,
  descKey,
  setting,
  locked,
  onEdit,
}: {
  target: LlmTarget;
  titleKey: PlKey;
  descKey: PlKey;
  setting: MaskedSettingDto | undefined;
  /** Embeddingi przy ≥1 aktywnej KB — bez edycji. */
  locked: boolean;
  onEdit: () => void;
}) {
  const configured = setting?.configured === true;
  const test = useMutation({
    mutationFn: () =>
      apiFetch<TestLlmResult>('/api/v1/settings/test-llm', { method: 'POST', body: { target } }),
  });

  return (
    <Card>
      <CardBody className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text">{t(titleKey)}</h3>
            <Badge variant={configured ? 'ok' : 'neutral'}>
              {configured
                ? t('settings.llm.keyConfigured', { preview: setting?.preview ?? '***' })
                : t('settings.llm.keyNotConfigured')}
            </Badge>
            {locked && (
              <Badge variant="warn">
                <Lock size={11} aria-hidden="true" />
                {t('settings.llm.lockedBadge')}
              </Badge>
            )}
            {test.isSuccess && (
              <Badge variant="ok">
                {t('settings.llm.testOkBadge', { model: test.data.model, ms: test.data.latencyMs })}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-text-secondary">{t(descKey)}</p>
          {setting?.updatedAt !== undefined && (
            <p className="mt-0.5 text-xs text-text-tertiary">
              {t('settings.llm.updatedAt', { at: formatDateTime(setting.updatedAt) })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" disabled={!configured} loading={test.isPending} onClick={() => test.mutate()}>
            {t('settings.llm.test')}
          </Button>
          {!locked && (
            <Button size="sm" variant="primary" onClick={onEdit}>
              {t('settings.llm.configure')}
            </Button>
          )}
        </div>
        {test.isError && (
          <Alert variant="fail" className="w-full">
            {errMsg(test.error)}
          </Alert>
        )}
        {target === 'embeddings' && !locked && (
          <Alert variant="warn" className="w-full">
            {t('settings.llm.embeddingsWarning')}
          </Alert>
        )}
        {locked && (
          <Alert variant="info" className="w-full">
            {t('settings.llm.embeddingsLocked')}
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}

export function LlmSection() {
  const settings = useSettings();
  const kbs = useQuery({
    queryKey: ['kbs'],
    queryFn: () => apiFetch<{ items: { namespace: string; status: string }[] }>('/api/v1/kbs'),
  });
  const [editTarget, setEditTarget] = useState<LlmTarget | null>(null);

  if (settings.isPending || kbs.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }
  if (settings.isError) {
    return (
      <Alert variant="fail" title={t('common.error')}>
        <div className="flex flex-col items-start gap-2">
          {errMsg(settings.error)}
          <Button size="sm" onClick={() => void settings.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      </Alert>
    );
  }

  // Model embeddingów jest niezmienialny po utworzeniu bazy — przy ≥1 aktywnej
  // KB edycja embeddingów jest zablokowana (docs: pipeline-frontend §e).
  const hasActiveKb = (kbs.data?.items ?? []).some((kb) => kb.status === 'active');
  const editEntry = editTarget !== null ? TARGETS.find((e) => e.target === editTarget) : undefined;

  return (
    <div className="flex flex-col gap-3">
      {TARGETS.map(({ target, titleKey, descKey }) => (
        <LlmRow
          key={target}
          target={target}
          titleKey={titleKey}
          descKey={descKey}
          setting={settings.data[`llm.${target}`]}
          locked={target === 'embeddings' && hasActiveKb}
          onEdit={() => setEditTarget(target)}
        />
      ))}
      {editEntry !== undefined && (
        <LlmEditDialog
          target={editEntry.target}
          titleKey={editEntry.titleKey}
          setting={settings.data[`llm.${editEntry.target}`]}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}
