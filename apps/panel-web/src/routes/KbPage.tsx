/**
 * /kb v2 — rejestr baz wiedzy (jedyne źródło prawdy: SQLite przez panel-api).
 * PageHeader + pasek narzędzi (filtr kliencki name/namespace, Select statusu —
 * ARCHIWALNE domyślnie ukryte, licznik), DataTable v2 z PEŁNYM sortem
 * klienckim i mobileCard. Kolumna „Ocena jakości" podłączona REALNIE
 * (GET :ns/quality per wiersz). Akcje wiersza w DropdownMenu „…":
 * Build (preflight+checkbox ostrzeżeń), Oceń jakość (202→ActionProgress),
 * Szczegóły (Sheet), Archiwizuj (admin, AlertDialog z przepisaniem namespace).
 * Nowa baza (admin) = wizard 3 kroków. Kontrakt: apps/panel-api/src/routes/kbs.ts.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Archive, ChartLine, Database, Hammer, Info, MoreHorizontal, Plus, RefreshCw, SearchX } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { can } from '@/lib/permissions';
import { useMe } from '@/hooks/useMe';
import { t, formatNumber } from '@/i18n/t';
import { Badge } from '@/ui/badge';
import { Button, IconButton } from '@/ui/button';
import { DataTable, type Column, type SortState } from '@/ui/data-table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { EmptyState } from '@/ui/empty-state';
import { PageContainer } from '@/ui/page-container';
import { PageHeader } from '@/ui/page-header';
import { SearchInput } from '@/ui/search-input';
import { Select } from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';
import { Tooltip } from '@/ui/tooltip';
import { useToast } from '@/ui/toast';
import { ActionProgress } from '@/components/ActionProgress';
import { statusLabel } from '@/lib/status';
import {
  filterKbs,
  KB_STATUS_FILTERS,
  sortKbs,
  type KbStatusFilter,
} from '@/components/kb/kb-lib';
import { KbArchiveDialog } from '@/components/kb/KbArchiveDialog';
import { KbBuildDialog } from '@/components/kb/KbBuildDialog';
import { KbCreateWizard } from '@/components/kb/KbCreateWizard';
import { KbDetailsSheet } from '@/components/kb/KbDetailsSheet';
import { QualityCell } from '@/components/kb/QualityCell';
import { StatusBadgeV2 } from '@/components/kb/StatusBadgeV2';
import type { KbEntry, LaunchedAction } from '@/components/kb/types';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

/** Plakietka „wymaga builda" z tooltipem (kolumna dirty + karta mobile). */
function DirtyBadge() {
  return (
    <Tooltip content={t('kb.dirtyTooltip')}>
      <Badge variant="warn">
        <RefreshCw size={12} aria-hidden="true" />
        {t('kb.dirtyChip')}
      </Badge>
    </Tooltip>
  );
}

/** Zawartość: „{docs} dok. · {chunks}" + pending jako Badge-link do /inbox?kb=. */
function TotalsCell({ kb }: { kb: KbEntry }) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span>
        {t('kb.totals.summary', {
          docs: formatNumber(kb.totals.documents),
          chunks: formatNumber(kb.totals.chunks),
        })}
      </span>
      {kb.totals.pendingDrafts > 0 && (
        <Link
          to="/inbox"
          search={{ kb: kb.namespace }}
          onClick={(ev) => ev.stopPropagation()}
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Badge variant="accent">
            {t('kb.totals.pending', { count: formatNumber(kb.totals.pendingDrafts) })}
          </Badge>
        </Link>
      )}
    </div>
  );
}

export function KbPage() {
  const me = useMe();
  const role = me.data?.user.role;
  const canBuild = can(role, 'kb-build');
  const canCreate = can(role, 'kb-create');
  const isAdmin = role === 'admin';
  const toast = useToast();

  const kbsQuery = useQuery({
    queryKey: ['kbs'],
    queryFn: () => apiFetch<{ items: KbEntry[] }>('/api/v1/kbs'),
  });
  const kbs = kbsQuery.data?.items ?? [];

  // Filtr + sort KLIENCKIE (lista niepaginowana — sort pełny).
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<KbStatusFilter>('all');
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const visible = useMemo(
    () => sortKbs(filterKbs(kbs, query, statusFilter), sort),
    [kbs, query, statusFilter, sort],
  );

  // Dialogi / sheety.
  const [buildKb, setBuildKb] = useState<KbEntry | null>(null);
  const [detailsNs, setDetailsNs] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveKb, setArchiveKb] = useState<KbEntry | null>(null);
  const [qualityKb, setQualityKb] = useState<{ kb: KbEntry; actionId: string } | null>(null);

  const quality = useMutation({
    mutationFn: (kb: KbEntry) =>
      apiFetch<Partial<LaunchedAction>>(`/api/v1/kbs/${kb.namespace}/quality`, { method: 'POST' }),
    onSuccess: (data, kb) => {
      toast.show(t('kb.quality.started'), 'ok');
      if (typeof data.actionId === 'string') setQualityKb({ kb, actionId: data.actionId });
    },
    onError: (err) => toast.show(t('kb.quality.failed', { message: errorMessage(err) }), 'fail'),
  });

  const rowMenu = (kb: KbEntry) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label={t('kb.rowMenu', { name: kb.name })}>
          <MoreHorizontal size={16} aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canBuild && (
          <DropdownMenuItem onSelect={() => setBuildKb(kb)}>
            <Hammer size={16} aria-hidden="true" />
            {t('kb.action.build')}
          </DropdownMenuItem>
        )}
        {canBuild && (
          <DropdownMenuItem disabled={quality.isPending} onSelect={() => quality.mutate(kb)}>
            <ChartLine size={16} aria-hidden="true" />
            {t('kb.action.quality')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => setDetailsNs(kb.namespace)}>
          <Info size={16} aria-hidden="true" />
          {t('kb.action.details')}
        </DropdownMenuItem>
        {isAdmin && kb.status !== 'archived' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => setArchiveKb(kb)}>
              <Archive size={16} aria-hidden="true" />
              {t('kb.action.archive')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const columns: readonly Column<KbEntry>[] = useMemo(
    () => [
      {
        key: 'name',
        header: t('kb.col.name'),
        sortable: true,
        render: (kb) => (
          <div className="flex flex-col gap-0.5 py-1.5">
            <span className="font-medium text-text">{kb.name}</span>
            <code className="font-mono text-xs text-text-tertiary">{kb.namespace}</code>
          </div>
        ),
      },
      {
        key: 'status',
        header: t('kb.col.status'),
        sortable: true,
        render: (kb) => <StatusBadgeV2 status={kb.status} />,
      },
      {
        key: 'quality',
        header: t('kb.col.quality'),
        render: (kb) => <QualityCell namespace={kb.namespace} />,
      },
      {
        key: 'dirty',
        header: t('kb.col.dirty'),
        sortable: true,
        hideBelow: 'md',
        render: (kb) =>
          kb.dirty ? <DirtyBadge /> : <span className="text-text-tertiary">{t('kb.upToDate')}</span>,
      },
      {
        key: 'totals',
        header: t('kb.col.totals'),
        sortable: true,
        hideBelow: 'sm',
        render: (kb) => <TotalsCell kb={kb} />,
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        render: (kb) => (
          <div className="flex justify-end" onClick={(ev) => ev.stopPropagation()}>
            {rowMenu(kb)}
          </div>
        ),
      },
    ],
    // rowMenu zależy od stabilnych setterów + roli i stanu mutacji quality.
    [canBuild, isAdmin, quality.isPending],
  );

  const mobileCard = (kb: KbEntry) => (
    <div
      role="button"
      tabIndex={0}
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
      onClick={() => setDetailsNs(kb.namespace)}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          setDetailsNs(kb.namespace);
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-text">{kb.name}</span>
          <code className="font-mono text-xs text-text-tertiary">{kb.namespace}</code>
        </div>
        <div onClick={(ev) => ev.stopPropagation()}>{rowMenu(kb)}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadgeV2 status={kb.status} />
        {kb.dirty && <DirtyBadge />}
      </div>
      <div className="text-sm text-text-secondary">
        <TotalsCell kb={kb} />
      </div>
    </div>
  );

  const createButton = canCreate ? (
    <Button variant="primary" iconLeft={<Plus size={16} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>
      {t('kb.create.button')}
    </Button>
  ) : undefined;

  const emptyState =
    kbs.length === 0 ? (
      <EmptyState
        icon={Database}
        title={t('kb.empty.title')}
        description={canCreate ? t('kb.empty.description') : t('kb.empty.askAdmin')}
        {...(createButton !== undefined ? { action: createButton } : {})}
      />
    ) : (
      <EmptyState icon={SearchX} title={t('kb.noMatches')} />
    );

  return (
    <PageContainer width="full">
      <PageHeader
        title={t('nav.kb')}
        description={t('kb.pageDescription')}
        {...(createButton !== undefined ? { actions: createButton } : {})}
      />

      {kbsQuery.isError ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-4">
          <p className="text-sm text-text">{errorMessage(kbsQuery.error)}</p>
          <Button onClick={() => void kbsQuery.refetch()}>{t('common.retry')}</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              className="w-full sm:max-w-72"
              placeholder={t('kb.searchPlaceholder')}
              onDebouncedChange={setQuery}
            />
            <Select
              aria-label={t('kb.filter.statusLabel')}
              wrapperClassName="w-44"
              value={statusFilter}
              onChange={(ev) => setStatusFilter(ev.target.value as KbStatusFilter)}
            >
              {KB_STATUS_FILTERS.map((filter) => (
                <option key={filter} value={filter}>
                  {filter === 'all' ? t('kb.filter.all') : statusLabel(filter)}
                </option>
              ))}
            </Select>
            <span className="ml-auto text-xs text-text-secondary">
              {t('kb.count', { count: formatNumber(visible.length) })}
            </span>
          </div>

          <DataTable
            columns={columns}
            rows={visible}
            rowKey={(kb) => kb.namespace}
            {...(sort !== undefined ? { sort } : {})}
            onSortChange={setSort}
            onRowClick={(kb) => setDetailsNs(kb.namespace)}
            loading={kbsQuery.isLoading}
            mobileCard={mobileCard}
            empty={emptyState}
          />
        </div>
      )}

      <KbBuildDialog kb={buildKb} onClose={() => setBuildKb(null)} />
      <KbDetailsSheet namespace={detailsNs} onClose={() => setDetailsNs(null)} />
      <KbCreateWizard open={createOpen} onClose={() => setCreateOpen(false)} />
      <KbArchiveDialog kb={archiveKb} onClose={() => setArchiveKb(null)} />

      {/* Obserwacja akcji quality (202+actionId) — jak dotychczas, w Dialogu. */}
      <Dialog open={qualityKb !== null} onOpenChange={(open) => !open && setQualityKb(null)}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>
              {qualityKb !== null ? t('kb.quality.modalTitle', { name: qualityKb.kb.name }) : ''}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            {qualityKb !== null ? (
              <ActionProgress
                actionId={qualityKb.actionId}
                onFinished={() => {
                  void queryClient.invalidateQueries({ queryKey: ['kbs'] });
                }}
              />
            ) : (
              <Skeleton className="h-16 w-full" />
            )}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setQualityKb(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
