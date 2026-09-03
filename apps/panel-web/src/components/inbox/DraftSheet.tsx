/**
 * Szczegóły szkicu w Sheet (side right, lg) — podgląd markdown, metadane jako
 * details-list (surowy JSON tylko w zwijanych „Danych technicznych"), edycja
 * pól recenzenckich (pending), akcje wg macierzy potwierdzeń:
 * promote bez dialogu (toast), reject z WYMAGANYM powodem (Dialog sm),
 * withdraw przez AlertDialog destructive.
 */
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { t, formatDateTime, formatNumber } from '@/i18n/t';
import { Markdown } from '@/components/Markdown';
import { Alert } from '@/ui/alert';
import { AlertDialog } from '@/ui/alert-dialog';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { CodeBlock } from '@/ui/code-block';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { Select } from '@/ui/select';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/ui/sheet';
import { SkeletonText } from '@/ui/skeleton';
import { Textarea } from '@/ui/textarea';
import { useToast } from '@/ui/toast';
import { draftStatusBadge, sourceLabel } from './badges';
import { metadataEntries } from './detailsList';
import { REJECT_REASON_MAX, REJECT_REASON_MIN, validateRejectReason } from './rejectReason';
import type { DraftDetail, DraftListItem, KbItem } from './types';

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return t('common.error');
}

export interface DraftSheetProps {
  draftId: string | null;
  onClose: () => void;
  kbByNs: ReadonlyMap<string, KbItem>;
  kbs: readonly KbItem[];
  canReview: boolean;
  /** Po każdej mutacji (invalidate list + liczników). */
  onChanged: () => void;
}

interface DraftEditForm {
  title: string;
  tags: string;
  namespace: string;
  documentCategory: string;
}

export function DraftSheet({ draftId, onClose, kbByNs, kbs, canReview, onChanged }: DraftSheetProps) {
  const toast = useToast();
  const [edit, setEdit] = useState<DraftEditForm | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  useEffect(() => {
    setEdit(null);
    setRejectOpen(false);
    setRejectReason('');
    setRejectError(null);
    setWithdrawOpen(false);
  }, [draftId]);

  const detailQuery = useQuery({
    queryKey: ['drafts', draftId],
    queryFn: () => apiFetch<{ draft: DraftDetail }>(`/api/v1/drafts/${draftId}`),
    enabled: draftId !== null,
  });
  const draft = detailQuery.data?.draft;

  const done = (message: string, kind: 'ok' | 'warn' = 'ok'): void => {
    toast.show(message, kind);
    onChanged();
    if (draftId !== null) void queryClient.invalidateQueries({ queryKey: ['drafts', draftId] });
    onClose();
  };

  const promote = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ draft: DraftListItem; resolvedGaps: number }>(`/api/v1/drafts/${id}/promote`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['gaps'] });
      done(
        data.resolvedGaps > 0
          ? t('inbox.toast.promotedGaps', { count: data.resolvedGaps })
          : t('inbox.toast.promoted'),
      );
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const reject = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      apiFetch<{ draft: DraftListItem }>(`/api/v1/drafts/${input.id}/reject`, {
        method: 'POST',
        body: { reason: input.reason },
      }),
    onSuccess: () => {
      setRejectOpen(false);
      done(t('inbox.toast.rejected'), 'warn');
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const withdraw = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ draft: DraftListItem }>(`/api/v1/drafts/${id}/withdraw`, { method: 'POST' }),
    onSuccess: () => {
      setWithdrawOpen(false);
      done(t('inbox.toast.withdrawn'), 'warn');
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const patch = useMutation({
    mutationFn: (input: { id: string; form: DraftEditForm }) => {
      const tags = input.form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '');
      return apiFetch<{ draft: DraftDetail }>(`/api/v1/drafts/${input.id}`, {
        method: 'PATCH',
        body: {
          title: input.form.title.trim(),
          tags,
          namespace: input.form.namespace,
          documentCategory:
            input.form.documentCategory.trim() === '' ? null : input.form.documentCategory.trim(),
        },
      });
    },
    onSuccess: () => {
      toast.show(t('inbox.toast.saved'), 'ok');
      setEdit(null);
      onChanged();
      if (draftId !== null) void queryClient.invalidateQueries({ queryKey: ['drafts', draftId] });
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  function submitReject(ev?: FormEvent): void {
    ev?.preventDefault();
    if (draft === undefined || reject.isPending) return;
    const verdict = validateRejectReason(rejectReason);
    if (!verdict.ok) {
      setRejectError(
        verdict.code === 'tooShort'
          ? t('inbox.reject.reasonTooShort', { min: REJECT_REASON_MIN })
          : t('inbox.reject.reasonTooLong', { max: formatNumber(REJECT_REASON_MAX) }),
      );
      return;
    }
    setRejectError(null);
    reject.mutate({ id: draft.id, reason: verdict.reason });
  }

  const kbActive = draft !== undefined && kbByNs.get(draft.namespace)?.status === 'active';
  const analysis = draft?.analysis ?? null;
  const analysisProvider =
    analysis !== null && typeof analysis['provider'] === 'string' ? analysis['provider'] : null;
  const analysisWarnings =
    analysis !== null && Array.isArray(analysis['warnings'])
      ? (analysis['warnings'] as unknown[]).filter((w): w is string => typeof w === 'string')
      : [];
  const entries = draft !== undefined ? metadataEntries(draft.metadata) : [];

  return (
    <>
      <Sheet open={draftId !== null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="right" size="lg">
          <SheetHeader>
            <SheetTitle className="pr-4">{draft?.title ?? t('inbox.draft.modalTitle')}</SheetTitle>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-4">
            {detailQuery.isLoading && <SkeletonText lines={6} />}
            {detailQuery.isError && (
              <Alert variant="fail">{errorMessage(detailQuery.error)}</Alert>
            )}
            {draft !== undefined && (
              <>
                {/* meta-rząd: status, baza, provider analizy, źródło, data, długość */}
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                  {draftStatusBadge(draft.status)}
                  <Badge variant="neutral" tone="outline">
                    <code className="font-mono">{draft.namespace}</code>
                  </Badge>
                  {analysisProvider !== null && (
                    <Badge variant="accent">
                      {t('inbox.draft.analysisProvider', { provider: analysisProvider })}
                    </Badge>
                  )}
                  <span>{sourceLabel(draft.sourceType)}</span>
                  <span>{formatDateTime(draft.createdAt)}</span>
                  {draft.contentLength !== null && (
                    <span>{t('inbox.draft.contentLength', { count: formatNumber(draft.contentLength) })}</span>
                  )}
                </div>

                {analysisWarnings.length > 0 && (
                  <Alert variant="warn" title={t('inbox.draft.analysisWarnings')}>
                    <ul className="list-disc pl-4">
                      {analysisWarnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </Alert>
                )}

                {draft.rejectReason !== null && draft.rejectReason !== '' && (
                  <Alert variant="warn" title={t('inbox.draft.rejectReason')}>
                    {draft.rejectReason}
                  </Alert>
                )}

                {edit !== null ? (
                  <form
                    className="flex flex-col gap-3"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      patch.mutate({ id: draft.id, form: edit });
                    }}
                  >
                    <Field label={t('inbox.edit.title')} required>
                      <Input
                        value={edit.title}
                        required
                        onChange={(ev) => setEdit({ ...edit, title: ev.target.value })}
                      />
                    </Field>
                    <Field label={t('inbox.edit.tags')}>
                      <Input
                        value={edit.tags}
                        onChange={(ev) => setEdit({ ...edit, tags: ev.target.value })}
                      />
                    </Field>
                    <Field label={t('inbox.edit.kb')}>
                      <Select
                        value={edit.namespace}
                        onChange={(ev) => setEdit({ ...edit, namespace: ev.target.value })}
                      >
                        {kbs.map((kb) => (
                          <option key={kb.namespace} value={kb.namespace} disabled={kb.status !== 'active'}>
                            {kb.name} ({kb.namespace})
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t('inbox.edit.category')}>
                      <Input
                        value={edit.documentCategory}
                        placeholder={t('inbox.edit.categoryPlaceholder')}
                        onChange={(ev) => setEdit({ ...edit, documentCategory: ev.target.value })}
                      />
                    </Field>
                    <div className="flex justify-end gap-2">
                      <Button onClick={() => setEdit(null)}>{t('common.cancel')}</Button>
                      <Button type="submit" variant="primary" loading={patch.isPending}>
                        {t('common.save')}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    {draft.tags.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-text-secondary">{t('inbox.draft.tags')}:</span>
                        {draft.tags.map((tag) => (
                          <Badge key={tag} variant="neutral" tone="outline">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}

                    <section className="flex flex-col gap-2">
                      <h3 className="text-sm font-medium text-text">{t('inbox.draft.content')}</h3>
                      {draft.contentMd !== null && draft.contentMd !== '' ? (
                        <Markdown text={draft.contentMd} />
                      ) : (
                        <p className="text-sm text-text-secondary">{t('inbox.draft.noContent')}</p>
                      )}
                    </section>

                    {entries.length > 0 && (
                      <section className="flex flex-col gap-2">
                        <h3 className="text-sm font-medium text-text">{t('inbox.draft.metadata')}</h3>
                        <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1 text-sm">
                          {entries.map((entry) => (
                            <Fragment key={entry.key}>
                              <dt className="truncate font-mono text-xs leading-6 text-text-secondary">
                                {entry.key}
                              </dt>
                              <dd className="min-w-0 break-words leading-6 text-text">
                                {entry.isDate ? formatDateTime(entry.value) : entry.value}
                              </dd>
                            </Fragment>
                          ))}
                        </dl>
                        <details>
                          <summary className="cursor-pointer text-xs text-text-secondary hover:text-text">
                            {t('inbox.draft.technical')}
                          </summary>
                          <CodeBlock
                            className="mt-2"
                            code={JSON.stringify(draft.metadata, null, 2)}
                            language="json"
                            maxHeight={240}
                          />
                        </details>
                      </section>
                    )}
                  </>
                )}
              </>
            )}
          </SheetBody>
          {draft !== undefined && canReview && edit === null && (
            <SheetFooter>
              {draft.status === 'pending' && (
                <>
                  <Button
                    onClick={() =>
                      setEdit({
                        title: draft.title,
                        tags: draft.tags.join(', '),
                        namespace: draft.namespace,
                        documentCategory: draft.documentCategory ?? '',
                      })
                    }
                  >
                    {t('inbox.action.edit')}
                  </Button>
                  <Button onClick={() => setRejectOpen(true)}>{t('inbox.action.reject')}</Button>
                  <Button
                    variant="primary"
                    disabled={!kbActive}
                    loading={promote.isPending}
                    {...(!kbActive
                      ? { title: t('inbox.action.promoteBlocked', { kb: draft.namespace }) }
                      : {})}
                    onClick={() => promote.mutate(draft.id)}
                  >
                    {t('inbox.action.promote')}
                  </Button>
                </>
              )}
              {draft.status === 'promoted' && (
                <Button variant="danger" onClick={() => setWithdrawOpen(true)}>
                  {t('inbox.action.withdraw')}
                </Button>
              )}
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>

      {/* Reject: Dialog sm z WYMAGANYM powodem (macierz potwierdzeń) */}
      <Dialog open={rejectOpen} onOpenChange={(open) => !reject.isPending && setRejectOpen(open)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('inbox.reject.title')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitReject}>
            <DialogBody>
              <Field
                label={t('inbox.reject.reasonLabel')}
                required
                hint={t('inbox.reject.reasonHint')}
                {...(rejectError !== null ? { error: rejectError } : {})}
              >
                <Textarea
                  rows={3}
                  value={rejectReason}
                  placeholder={t('inbox.action.rejectReasonPlaceholder')}
                  onChange={(ev) => {
                    setRejectReason(ev.target.value);
                    if (rejectError !== null) setRejectError(null);
                  }}
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button disabled={reject.isPending} onClick={() => setRejectOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="danger" loading={reject.isPending}>
                {t('inbox.action.reject')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Withdraw: AlertDialog destructive (macierz potwierdzeń) */}
      <AlertDialog
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        title={t('inbox.withdraw.title')}
        objectName={draft?.title ?? ''}
        consequences={[
          t('inbox.withdraw.consequenceRemove', { ns: draft?.namespace ?? '' }),
          t('inbox.withdraw.consequenceBuild'),
        ]}
        confirmLabel={t('inbox.action.withdraw')}
        destructive
        loading={withdraw.isPending}
        onConfirm={() => draft !== undefined && withdraw.mutate(draft.id)}
      />
    </>
  );
}
