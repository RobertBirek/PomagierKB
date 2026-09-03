/**
 * Archiwizacja bazy (admin): AlertDialog destrukcyjny z potwierdzeniem
 * PRZEPISANIEM namespace — prymitywy alert-dialog (wariant z children/Input),
 * bo wysokopoziomowy <AlertDialog/> nie wspiera disabled na Confirm.
 * API: PATCH /api/v1/kbs/:ns {status:'archived'} (soft delete, zweryfikowane).
 */
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { t } from '@/i18n/t';
import {
  AlertDialogCancel,
  AlertDialogConsequences,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogRoot,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Button } from '@/ui/button';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { useToast } from '@/ui/toast';
import { archiveConfirmed } from './kb-lib';
import type { KbEntry } from './types';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

export function KbArchiveDialog({ kb, onClose }: { kb: KbEntry | null; onClose: () => void }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');

  useEffect(() => setTyped(''), [kb?.namespace]);

  const archive = useMutation({
    mutationFn: (namespace: string) =>
      apiFetch<unknown>(`/api/v1/kbs/${namespace}`, { method: 'PATCH', body: { status: 'archived' } }),
    onSuccess: (_data, _namespace) => {
      void queryClient.invalidateQueries({ queryKey: ['kbs'] });
      toast.show(t('kb.archive.done', { name: kb?.name ?? '' }), 'ok');
      onClose();
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const confirmed = kb !== null && archiveConfirmed(typed, kb.namespace);

  return (
    <AlertDialogRoot open={kb !== null} onOpenChange={(open) => !open && !archive.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogTitle>{t('kb.archive.title')}</AlertDialogTitle>
        <AlertDialogDescription>
          <strong className="font-medium text-text">{kb?.name ?? ''}</strong>
        </AlertDialogDescription>
        <AlertDialogConsequences items={[t('kb.archive.c1'), t('kb.archive.c2')]} />
        <div className="px-5 pt-3">
          <Field label={t('kb.archive.confirmField', { namespace: kb?.namespace ?? '' })}>
            <Input
              value={typed}
              spellCheck={false}
              autoComplete="off"
              placeholder={kb?.namespace ?? ''}
              onChange={(ev) => setTyped(ev.target.value)}
            />
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button disabled={archive.isPending}>{t('common.cancel')}</Button>
          </AlertDialogCancel>
          <Button
            variant="danger"
            disabled={!confirmed}
            loading={archive.isPending}
            onClick={() => kb !== null && archive.mutate(kb.namespace)}
          >
            {t('kb.archive.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
