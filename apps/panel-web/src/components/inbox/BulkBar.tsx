/**
 * Dolny pływający pasek akcji zbiorczych Inboxu (fixed bottom, wycentrowany;
 * ukryty <768px — faza 1 planu) + dwufazowy przepływ bulk: dryRun → Dialog lg
 * z raportem per szkic → apply tylko pozycji bez konfliktu.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/i18n/t';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { useToast } from '@/ui/toast';
import type { BulkReport } from './types';

/** Powód konfliktu bywa prefiksowany kodem ('conflict: …') — pokazujemy część PL. */
export function formatBulkReason(reason: string | undefined): string {
  if (reason === undefined || reason === '') return t('inbox.bulk.conflict');
  const match = /^[a-z_]+:\s*(.+)$/.exec(reason);
  return match?.[1] ?? reason;
}

export interface BulkBarProps {
  selected: readonly string[];
  /** Tytuły szkiców z bieżącej strony (raport dryRun pokazuje tytuł zamiast id). */
  titleById: ReadonlyMap<string, string>;
  onClear: () => void;
  /** Po udanym apply (invalidate list + czyszczenie selekcji robi strona). */
  onApplied: () => void;
}

export function BulkBar({ selected, titleById, onClear, onApplied }: BulkBarProps) {
  const toast = useToast();
  const [state, setState] = useState<{ op: 'promote' | 'reject'; report: BulkReport } | null>(null);

  const errorMessage = (err: unknown): string =>
    err instanceof ApiError ? err.message : t('common.error');

  const dryRun = useMutation({
    mutationFn: (op: 'promote' | 'reject') =>
      apiFetch<BulkReport>('/api/v1/drafts/bulk', {
        method: 'POST',
        body: { op, ids: [...selected], dryRun: true },
      }),
    onSuccess: (report, op) => setState({ op, report }),
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const apply = useMutation({
    mutationFn: (op: 'promote' | 'reject') =>
      apiFetch<BulkReport>('/api/v1/drafts/bulk', {
        method: 'POST',
        body: { op, ids: [...selected], dryRun: false },
      }),
    onSuccess: (report) => {
      const conflicts = report.results.filter((r) => !r.ok).length;
      toast.show(
        t('inbox.bulk.appliedToast', { applied: report.applied, conflicts }),
        conflicts > 0 ? 'warn' : 'ok',
      );
      setState(null);
      onApplied();
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  if (selected.length === 0) return null;
  const okCount = state?.report.results.filter((r) => r.ok).length ?? 0;

  return (
    <>
      <div
        className="fixed bottom-6 left-1/2 z-(--z-sticky) hidden -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2.5 shadow-lg md:flex"
        role="toolbar"
        aria-label={t('inbox.bulk.count', { n: selected.length })}
      >
        <span className="text-sm font-medium text-text">
          {t('inbox.bulk.count', { n: selected.length })}
        </span>
        <span className="h-4 w-px bg-border" aria-hidden="true" />
        <Button
          variant="primary"
          size="sm"
          disabled={dryRun.isPending}
          onClick={() => dryRun.mutate('promote')}
        >
          {t('inbox.action.promote')}
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={dryRun.isPending}
          onClick={() => dryRun.mutate('reject')}
        >
          {t('inbox.action.reject')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear}>
          {t('inbox.bulk.clear')}
        </Button>
      </div>

      {/* raport dryRun per szkic → apply (obecna logika dwufazowa) */}
      <Dialog open={state !== null} onOpenChange={(open) => !apply.isPending && !open && setState(null)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              {state?.op === 'reject' ? t('inbox.bulk.modalTitleReject') : t('inbox.bulk.modalTitlePromote')}
            </DialogTitle>
            <DialogDescription>{t('inbox.bulk.dryRunInfo')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {state !== null && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="text-xs font-medium text-text-secondary">
                    <tr>
                      <th className="h-8 border-b border-border px-3">{t('inbox.bulk.colDraft')}</th>
                      <th className="h-8 border-b border-border px-3">{t('inbox.bulk.colResult')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.report.results.map((result) => (
                      <tr key={result.id}>
                        <td className="border-b border-border/60 px-3 py-2">
                          {titleById.get(result.id) ?? result.id}
                        </td>
                        <td className="border-b border-border/60 px-3 py-2">
                          {result.ok ? (
                            <Badge variant="ok">{t('inbox.bulk.ok')}</Badge>
                          ) : (
                            <span className="flex items-center gap-2">
                              <Badge variant="fail">{t('inbox.bulk.conflict')}</Badge>
                              <span className="text-xs text-text-secondary">
                                {formatBulkReason(result.reason)}
                              </span>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button disabled={apply.isPending} onClick={() => setState(null)}>
              {t('common.cancel')}
            </Button>
            {state !== null && okCount > 0 ? (
              <Button
                variant={state.op === 'reject' ? 'danger' : 'primary'}
                loading={apply.isPending}
                onClick={() => apply.mutate(state.op)}
              >
                {t('inbox.bulk.apply', { count: okCount })}
              </Button>
            ) : (
              <span className="self-center text-sm text-text-secondary">
                {t('inbox.bulk.nothingToApply')}
              </span>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
