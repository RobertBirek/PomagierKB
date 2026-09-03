/**
 * Kreator „Nowa baza" (admin) — 3 kroki w Dialogu lg ze wskaźnikiem kroków
 * (legacy Stepper): 1 Podstawy (nazwa → auto-sugestia namespace, walidacja
 * live), 2 Typy dokumentów (dynamiczna lista + chipy-przykłady, max 20),
 * 3 Infrastruktura (createProject, Alert o NIEZMIENNOŚCI embeddingu,
 * podsumowanie). POST /api/v1/kbs; 202 → ActionProgress w tym samym dialogu.
 * Logika stanu kreatora: kb-lib.ts (czysta, testowana).
 */
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { namespaceProblem, type NamespaceProblem } from '@/lib/namespace';
import { statusLabel } from '@/lib/status';
import { t } from '@/i18n/t';
import type { PlKey } from '@/i18n/pl';
import { Alert } from '@/ui/alert';
import { Button, IconButton } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { useToast } from '@/ui/toast';
import { ActionProgress } from '../ActionProgress';
import { Stepper, type Step } from '../Stepper';
import type { ActionState } from '@/hooks/useAction';
import {
  addDocTypeRow,
  addExampleDocType,
  canProceed,
  DOC_TYPE_EXAMPLES,
  initialWizardState,
  MAX_DOC_TYPES,
  setWizardName,
  setWizardNamespace,
  wizardBack,
  wizardNext,
  wizardPayload,
  type KbWizardState,
} from './kb-lib';
import type { KbEntry, LaunchedAction } from './types';

const NS_ERROR_KEY: Record<NamespaceProblem, PlKey> = {
  empty: 'kb.nsError.empty',
  tooShort: 'kb.nsError.tooShort',
  tooLong: 'kb.nsError.tooLong',
  badStart: 'kb.nsError.badStart',
  badChars: 'kb.nsError.badChars',
};

const STEP_META: readonly { label: PlKey; description: PlKey }[] = [
  { label: 'kb.wizard.step1', description: 'kb.wizard.step1Desc' },
  { label: 'kb.wizard.step2', description: 'kb.wizard.step2Desc' },
  { label: 'kb.wizard.step3', description: 'kb.wizard.step3Desc' },
];

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

export function KbCreateWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<KbWizardState>(initialWizardState);
  const [actionId, setActionId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setState(initialWizardState());
      setActionId(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: (input: KbWizardState) =>
      apiFetch<{ kb: KbEntry } & Partial<LaunchedAction>>('/api/v1/kbs', {
        method: 'POST',
        body: wizardPayload(input),
      }),
    onSuccess: (data, input) => {
      void queryClient.invalidateQueries({ queryKey: ['kbs'] });
      if (typeof data.actionId === 'string') {
        // 202 — provisioning projektu OpenSPG w tle: obserwacja w tym samym dialogu.
        setActionId(data.actionId);
      } else {
        toast.show(t('kb.create.created', { name: input.name.trim() }), 'ok');
        onClose();
      }
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const onProvisionFinished = (finished: ActionState): void => {
    void queryClient.invalidateQueries({ queryKey: ['kbs'] });
    toast.show(
      t('kb.create.provisionFinished', { status: statusLabel(finished.status) }),
      finished.status === 'success' ? 'ok' : 'fail',
    );
  };

  const steps: Step[] = STEP_META.map((meta, i) => ({
    id: `step-${i + 1}`,
    label: t(meta.label),
    description: t(meta.description),
    status: i + 1 < state.step ? 'done' : i + 1 === state.step ? 'active' : 'pending',
  }));

  const nsProblem = namespaceProblem(state.namespace);
  const proceed = canProceed(state);

  const setDocType = (index: number, patch: Partial<{ name: string; description: string }>): void => {
    setState((prev) => ({
      ...prev,
      documentTypes: prev.documentTypes.map((docType, i) =>
        i === index ? { ...docType, ...patch } : docType,
      ),
    }));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('kb.create.modalTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {actionId !== null ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-secondary">{t('kb.create.provisioning')}</p>
              <ActionProgress actionId={actionId} onFinished={onProvisionFinished} />
            </div>
          ) : (
            <div className="flex flex-col gap-6 md:grid md:grid-cols-[220px_1fr]">
              {/* Wskaźnik kroków — legacy Stepper („prosto", pionowo). */}
              <Stepper steps={steps} />

              {state.step === 1 && (
                <div className="flex flex-col gap-4">
                  <Field label={t('kb.create.name')} required>
                    <Input
                      value={state.name}
                      placeholder={t('kb.create.namePlaceholder')}
                      onChange={(ev) => setState((prev) => setWizardName(prev, ev.target.value))}
                    />
                  </Field>
                  <Field
                    label={t('kb.create.namespace')}
                    required
                    {...(nsProblem !== null
                      ? { error: t(NS_ERROR_KEY[nsProblem]) }
                      : { hint: <span className="text-ok">{t('kb.nsOk')}</span> })}
                  >
                    <Input
                      value={state.namespace}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(ev) => setState((prev) => setWizardNamespace(prev, ev.target.value))}
                    />
                  </Field>
                  <p className="text-xs text-text-secondary">{t('kb.create.namespaceHint')}</p>
                  <Field label={t('kb.create.description')}>
                    <Textarea
                      rows={2}
                      value={state.description}
                      onChange={(ev) => setState((prev) => ({ ...prev, description: ev.target.value }))}
                    />
                  </Field>
                </div>
              )}

              {state.step === 2 && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-text-secondary">{t('kb.create.documentTypesHint')}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-text-tertiary">{t('kb.wizard.examples')}</span>
                    {DOC_TYPE_EXAMPLES.map((example) => (
                      <button
                        key={example}
                        type="button"
                        aria-label={t('kb.wizard.addExample', { name: example })}
                        className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-surface-2 px-2 text-xs text-text-secondary transition-colors hover:border-accent hover:text-accent"
                        onClick={() =>
                          setState((prev) => ({
                            ...prev,
                            documentTypes: addExampleDocType(prev.documentTypes, example),
                          }))
                        }
                      >
                        <Plus size={12} aria-hidden="true" />
                        {example}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-col gap-2">
                    {state.documentTypes.map((docType, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          value={docType.name}
                          placeholder={t('kb.create.docTypeName')}
                          aria-label={t('kb.create.docTypeName')}
                          className="max-w-48"
                          onChange={(ev) => setDocType(index, { name: ev.target.value })}
                        />
                        <Input
                          value={docType.description}
                          placeholder={t('kb.create.docTypeDescription')}
                          aria-label={t('kb.create.docTypeDescription')}
                          onChange={(ev) => setDocType(index, { description: ev.target.value })}
                        />
                        <IconButton
                          aria-label={t('kb.create.removeDocType')}
                          onClick={() =>
                            setState((prev) => ({
                              ...prev,
                              documentTypes: prev.documentTypes.filter((_, i) => i !== index),
                            }))
                          }
                        >
                          <X size={16} aria-hidden="true" />
                        </IconButton>
                      </div>
                    ))}
                  </div>
                  <div>
                    <Button
                      size="sm"
                      iconLeft={<Plus size={16} aria-hidden="true" />}
                      disabled={state.documentTypes.length >= MAX_DOC_TYPES}
                      onClick={() =>
                        setState((prev) => ({ ...prev, documentTypes: addDocTypeRow(prev.documentTypes) }))
                      }
                    >
                      {t('kb.create.addDocType')}
                    </Button>
                  </div>
                </div>
              )}

              {state.step === 3 && (
                <div className="flex flex-col gap-4">
                  <Alert variant="warn">{t('kb.create.embeddingWarning')}</Alert>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
                    <Checkbox
                      checked={state.createProject}
                      onCheckedChange={(checked) =>
                        setState((prev) => ({ ...prev, createProject: checked === true }))
                      }
                    />
                    {t('kb.create.createProject')}
                  </label>
                  <section className="rounded-lg border border-border bg-surface-2 p-3">
                    <h3 className="mb-2 text-sm font-medium text-text">{t('kb.wizard.summary')}</h3>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                      <dt className="text-text-secondary">{t('kb.col.name')}</dt>
                      <dd className="text-text">{state.name.trim()}</dd>
                      <dt className="text-text-secondary">{t('kb.col.namespace')}</dt>
                      <dd>
                        <code className="font-mono text-xs">{state.namespace}</code>
                      </dd>
                      <dt className="text-text-secondary">{t('kb.wizard.summaryDocTypes')}</dt>
                      <dd className="text-text">
                        {wizardPayload(state).documentTypes.length > 0
                          ? wizardPayload(state)
                              .documentTypes.map((docType) => docType.name)
                              .join(', ')
                          : t('kb.wizard.summaryDocTypesNone')}
                      </dd>
                    </dl>
                    <p className="mt-2 text-xs text-text-secondary">
                      {state.createProject
                        ? t('kb.wizard.summaryProjectYes')
                        : t('kb.wizard.summaryProjectNo')}
                    </p>
                  </section>
                </div>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {actionId !== null ? (
            <Button onClick={onClose}>{t('common.close')}</Button>
          ) : (
            <>
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              {state.step > 1 && (
                <Button onClick={() => setState((prev) => wizardBack(prev))}>{t('common.back')}</Button>
              )}
              {state.step < 3 ? (
                <Button
                  variant="primary"
                  disabled={!proceed}
                  onClick={() => setState((prev) => wizardNext(prev))}
                >
                  {t('common.next')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={!proceed}
                  loading={create.isPending}
                  onClick={() => proceed && create.mutate(state)}
                >
                  {t('kb.create.submit')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
