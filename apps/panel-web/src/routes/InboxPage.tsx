/**
 * /inbox „Skrzynka recenzji" — dwie kolejki human-in-the-loop na kicie v2:
 * - Szkice: pasek filtrów (Select+SearchInput z debounce → ?q= bez submitu),
 *   chipy aktywnych filtrów, DataTable v2 (selekcja pending, sort kliencki
 *   per-strona, licznik z meta.total), dolny pływający bulk-bar (dryRun→apply),
 *   szczegóły szkicu w Sheet (components/inbox/DraftSheet);
 * - Luki wiedzy: rząd MetricTile-filtrów + tabela z akcjami w DropdownMenu „…"
 *   (Ignoruj przez AlertDialog — nieodwracalne, brak reopen w API).
 * Kontrakt API: apps/panel-api/src/routes/{drafts,learning}.ts (meta.total).
 */
import { useEffect, useMemo, useReducer, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, FilePlus2, Inbox, MoreHorizontal, SearchX, X } from 'lucide-react';
import { apiFetch, apiFetchWithMeta, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { can } from '@/lib/permissions';
import { bulkSelectionReducer } from '@/lib/bulkSelection';
import { confidenceBadge } from '@/lib/confidence';
import { buildAddLinkSearch } from '@/lib/prefill';
import { useMe } from '@/hooks/useMe';
import { t, formatDateTime, formatNumber } from '@/i18n/t';
import type { PlKey } from '@/i18n/pl';
import type { InboxSearch } from '@/router';
import { Alert } from '@/ui/alert';
import { AlertDialog } from '@/ui/alert-dialog';
import { Badge } from '@/ui/badge';
import { Button, IconButton } from '@/ui/button';
import { DataTable, type Column, type SortState } from '@/ui/data-table';
import { pageRange } from '@/ui/data-table-core';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { EmptyState } from '@/ui/empty-state';
import { MetricTile } from '@/ui/metric-tile';
import { PageContainer } from '@/ui/page-container';
import { PageHeader } from '@/ui/page-header';
import { SearchInput } from '@/ui/search-input';
import { Select } from '@/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { Tooltip } from '@/ui/tooltip';
import { useToast } from '@/ui/toast';
import { BulkBar } from '@/components/inbox/BulkBar';
import { DraftSheet } from '@/components/inbox/DraftSheet';
import { draftStatusBadge, gapSourceLabel, gapStatusBadge, sourceLabel } from '@/components/inbox/badges';
import { buildDraftFilterChips, type DraftFilterKey } from '@/components/inbox/filterChips';
import { sortDrafts } from '@/components/inbox/draftSort';
import type { DraftListItem, GapItem, GapStats, KbItem } from '@/components/inbox/types';

const PAGE_LIMIT = 50;
const DRAFT_STATUSES = ['pending', 'promoted', 'rejected', 'withdrawn'] as const;
const GAP_STATUSES = ['open', 'in_draft', 'resolved', 'ignored'] as const;

/** Etykiety PL statusów draftu w filtrach (withdrawn spoza lib/status.ts). */
const DRAFT_STATUS_LABEL_KEY: Record<(typeof DRAFT_STATUSES)[number], PlKey> = {
  pending: 'status.pending',
  promoted: 'status.promoted',
  rejected: 'status.rejected',
  withdrawn: 'inbox.status.withdrawn',
};

const GAP_STAT_LABEL_KEY: Record<(typeof GAP_STATUSES)[number], PlKey> = {
  open: 'inbox.gaps.stat.open',
  in_draft: 'inbox.gaps.stat.in_draft',
  resolved: 'inbox.gaps.stat.resolved',
  ignored: 'inbox.gaps.stat.ignored',
};

/** Etykieta filtru statusu draftów (chipy + Select) — zna też 'all'. */
function draftStatusFilterLabel(status: string): string {
  if (status === 'all') return t('inbox.filter.all');
  const key = (DRAFT_STATUS_LABEL_KEY as Record<string, PlKey>)[status];
  return key !== undefined ? t(key) : status;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return t('common.error');
}

/**
 * Patch search-params może jawnie ustawiać undefined (= skasuj filtr) —
 * z exactOptionalPropertyTypes czyścimy go do InboxSearch bez undefined.
 */
interface SearchPatch {
  tab?: 'gaps' | undefined;
  status?: string | undefined;
  kb?: string | undefined;
  q?: string | undefined;
  page?: number | undefined;
}

function cleanSearch(raw: SearchPatch): InboxSearch {
  const out: InboxSearch = {};
  if (raw.tab === 'gaps') out.tab = 'gaps';
  if (raw.status !== undefined) out.status = raw.status;
  if (raw.kb !== undefined) out.kb = raw.kb;
  if (raw.q !== undefined) out.q = raw.q;
  if (raw.page !== undefined && raw.page > 1) out.page = raw.page;
  return out;
}

/** Nagłówek kolumny sortowalnej z tooltipem „sortuje bieżącą stronę". */
function pageSortHeader(label: string) {
  return (
    <Tooltip content={t('inbox.sort.pageOnly')}>
      <span>{label}</span>
    </Tooltip>
  );
}

// ── strona ──────────────────────────────────────────────────────────────────

export function InboxPage() {
  const search = useSearch({ from: '/inbox' });
  const navigate = useNavigate();
  const tab = search.tab === 'gaps' ? 'gaps' : 'drafts';

  // Licznik do opisu nagłówka: meta.total z GET /drafts (status=pending).
  const pendingTotalQuery = useQuery({
    queryKey: ['drafts', 'pending-total'],
    queryFn: () =>
      apiFetchWithMeta<{ items: DraftListItem[] }>('/api/v1/drafts?status=pending&page=1&limit=1'),
  });
  const pendingTotal = pendingTotalQuery.data?.meta?.total;

  return (
    <PageContainer width="full">
      <PageHeader
        title={t('inbox.header.title')}
        description={
          pendingTotal !== undefined
            ? t('inbox.header.descriptionCount', { total: formatNumber(pendingTotal) })
            : t('inbox.header.description')
        }
        tabs={
          <Tabs
            value={tab}
            onValueChange={(value) => {
              // Zmiana zakładki resetuje filtry (statusy draftów i luk to inne słowniki).
              void navigate({ to: '/inbox', search: value === 'gaps' ? { tab: 'gaps' } : {} });
            }}
          >
            <TabsList>
              <TabsTrigger value="drafts">{t('inbox.tab.drafts')}</TabsTrigger>
              <TabsTrigger value="gaps">{t('inbox.tab.gaps')}</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      {tab === 'drafts' ? <DraftsTab search={search} /> : <GapsTab search={search} />}
    </PageContainer>
  );
}

// ── zakładka: Szkice ────────────────────────────────────────────────────────

function DraftsTab({ search }: { search: InboxSearch }) {
  const navigate = useNavigate();
  const me = useMe();
  const role = me.data?.user.role;
  const canReview = can(role, 'inbox');

  const status = search.status ?? 'pending';
  const page = search.page ?? 1;

  const updateSearch = (patch: SearchPatch): void => {
    void navigate({ to: '/inbox', search: cleanSearch({ ...search, page: undefined, ...patch }) });
  };

  const kbsQuery = useQuery({
    queryKey: ['kbs'],
    queryFn: () => apiFetch<{ items: KbItem[] }>('/api/v1/kbs'),
  });
  const kbByNs = useMemo(() => {
    const map = new Map<string, KbItem>();
    for (const kb of kbsQuery.data?.items ?? []) map.set(kb.namespace, kb);
    return map;
  }, [kbsQuery.data]);

  const filters = { status, kb: search.kb, q: search.q, page };
  const draftsQuery = useQuery({
    queryKey: ['drafts', filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (search.kb !== undefined) params.set('namespace', search.kb);
      if (search.q !== undefined) params.set('q', search.q);
      params.set('page', String(page));
      params.set('limit', String(PAGE_LIMIT));
      return apiFetchWithMeta<{ items: DraftListItem[] }>(`/api/v1/drafts?${params.toString()}`);
    },
  });
  const drafts = draftsQuery.data?.data.items ?? [];
  const total = draftsQuery.data?.meta?.total;
  const hasNext = drafts.length === PAGE_LIMIT;

  // Sort KLIENCKI per-strona (API bez sort-param — tooltip przy nagłówkach).
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const sortedDrafts = useMemo(() => sortDrafts(drafts, sort), [drafts, sort]);

  // Selekcja bulk — czysty reducer (lib/bulkSelection.ts); TYLKO pending.
  const [selected, dispatchSelection] = useReducer(bulkSelectionReducer, [] as readonly string[]);
  const selectableIds = useMemo(
    () => drafts.filter((d) => d.status === 'pending').map((d) => d.id),
    [drafts],
  );
  useEffect(() => {
    // Po refetchu w selekcji zostają tylko szkice nadal pending na liście.
    dispatchSelection({ type: 'prune', keep: selectableIds });
  }, [selectableIds]);

  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);

  const invalidateDrafts = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    void queryClient.invalidateQueries({ queryKey: ['kbs'] }); // liczniki pendingDrafts
  };

  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of drafts) map.set(d.id, d.title);
    return map;
  }, [drafts]);

  const chips = buildDraftFilterChips(
    { status: search.status, kb: search.kb, q: search.q },
    draftStatusFilterLabel,
    (ns) => kbByNs.get(ns)?.name,
  );
  const clearChip = (key: DraftFilterKey): void => {
    if (key === 'status') updateSearch({ status: undefined });
    else if (key === 'kb') updateSearch({ kb: undefined });
    else updateSearch({ q: undefined });
  };

  const columns = useMemo<Column<DraftListItem>[]>(
    () => [
      {
        key: 'title',
        header: pageSortHeader(t('inbox.col.title')),
        sortable: true,
        render: (row) => <span className="font-medium text-text">{row.title}</span>,
      },
      {
        key: 'kb',
        header: t('inbox.col.kb'),
        render: (row) => <code className="font-mono text-xs">{row.namespace}</code>,
      },
      {
        key: 'category',
        header: t('inbox.col.category'),
        hideBelow: 'md',
        render: (row) => row.documentCategory ?? '—',
      },
      {
        key: 'source',
        header: t('inbox.col.source'),
        hideBelow: 'md',
        render: (row) => sourceLabel(row.sourceType),
      },
      {
        key: 'date',
        header: pageSortHeader(t('inbox.col.date')),
        sortable: true,
        render: (row) => <span className="text-text-secondary">{formatDateTime(row.createdAt)}</span>,
      },
      {
        key: 'status',
        header: pageSortHeader(t('inbox.col.status')),
        sortable: true,
        render: (row) => draftStatusBadge(row.status),
      },
    ],
    [],
  );

  const hasFilters = status !== 'pending' || search.kb !== undefined || search.q !== undefined;
  const emptyState = hasFilters ? (
    <EmptyState
      icon={SearchX}
      title={t('inbox.empty.filteredTitle')}
      description={t('inbox.empty.filteredDescription')}
      action={
        <Button onClick={() => void navigate({ to: '/inbox', search: {} })}>
          {t('inbox.empty.clearFilters')}
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={Inbox}
      title={t('inbox.empty.title')}
      description={t('inbox.empty.description')}
      action={
        <Button variant="primary" onClick={() => void navigate({ to: '/add', search: {} })}>
          {t('inbox.empty.cta')}
        </Button>
      }
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {/* pasek filtrów jednoliniowy — stan w search-params (deep-linki), q bez submitu */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={t('inbox.filter.status')}
          value={status}
          wrapperClassName="w-40"
          onChange={(ev) =>
            updateSearch({ status: ev.target.value === 'pending' ? undefined : ev.target.value })
          }
        >
          {DRAFT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(DRAFT_STATUS_LABEL_KEY[s])}
            </option>
          ))}
          <option value="all">{t('inbox.filter.all')}</option>
        </Select>
        <Select
          aria-label={t('inbox.filter.kb')}
          value={search.kb ?? ''}
          wrapperClassName="w-56 max-w-full"
          onChange={(ev) => updateSearch({ kb: ev.target.value === '' ? undefined : ev.target.value })}
        >
          <option value="">{t('inbox.filter.all')}</option>
          {(kbsQuery.data?.items ?? []).map((kb) => (
            <option key={kb.namespace} value={kb.namespace}>
              {kb.name} ({kb.namespace})
            </option>
          ))}
        </Select>
        <SearchInput
          value={search.q ?? ''}
          delay={300}
          placeholder={t('inbox.filter.searchPlaceholder')}
          className="min-w-52 grow sm:max-w-md"
          onDebouncedChange={(value) => {
            const q = value.trim();
            updateSearch({ q: q === '' ? undefined : q });
          }}
        />
        {total !== undefined && total > 0 && (
          <span className="ml-auto text-xs tabular-nums text-text-secondary">
            {t('table.range', { ...pageRange(page, PAGE_LIMIT, total), total })}
          </span>
        )}
      </div>

      {/* chipy aktywnych filtrów */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Badge key={chip.key} variant="accent" tone="outline" className="h-6 gap-1 pl-2 pr-1">
              {chip.label}
              <button
                type="button"
                aria-label={t('inbox.chip.remove', { label: chip.label })}
                className="inline-flex size-4 items-center justify-center rounded-full transition-colors hover:bg-accent-tint"
                onClick={() => clearChip(chip.key)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </Badge>
          ))}
          <Button variant="ghost" size="sm" onClick={() => void navigate({ to: '/inbox', search: {} })}>
            {t('inbox.chip.clearAll')}
          </Button>
        </div>
      )}

      {draftsQuery.isError ? (
        <Alert variant="fail" title={errorMessage(draftsQuery.error)}>
          <Button className="mt-2" onClick={() => void draftsQuery.refetch()}>
            {t('common.retry')}
          </Button>
        </Alert>
      ) : (
        <DataTable
          columns={columns}
          rows={sortedDrafts}
          rowKey={(row) => row.id}
          loading={draftsQuery.isLoading}
          {...(sort !== undefined ? { sort } : {})}
          onSortChange={setSort}
          {...(canReview
            ? {
                selection: {
                  selected,
                  // Zaznaczalne są TYLKO szkice pending (bulk API odrzuca resztę).
                  onToggleRow: (id: string) => {
                    if (selectableIds.includes(id)) dispatchSelection({ type: 'toggle', id });
                  },
                  onToggleAll: (_visible: readonly string[], select: boolean) =>
                    dispatchSelection(
                      select
                        ? { type: 'selectMany', ids: selectableIds }
                        : { type: 'deselectMany', ids: selectableIds },
                    ),
                },
              }
            : {})}
          onRowClick={(row) => setSelectedDraftId(row.id)}
          pagination={{
            page,
            pageSize: PAGE_LIMIT,
            ...(total !== undefined ? { total } : { hasNext }),
            onPageChange: (next) => updateSearch({ page: next > 1 ? next : undefined }),
          }}
          stickyHeader
          empty={emptyState}
          mobileCard={(row) => (
            <button
              type="button"
              className="w-full rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-2"
              onClick={() => setSelectedDraftId(row.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-text">{row.title}</span>
                {draftStatusBadge(row.status)}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                <code className="font-mono">{row.namespace}</code>
                <span>{formatDateTime(row.createdAt)}</span>
              </div>
            </button>
          )}
        />
      )}

      {/* dolny pływający bulk-bar (ukryty <768px) + dryRun→apply */}
      {canReview && (
        <BulkBar
          selected={selected}
          titleById={titleById}
          onClear={() => dispatchSelection({ type: 'clear' })}
          onApplied={() => {
            dispatchSelection({ type: 'clear' });
            invalidateDrafts();
          }}
        />
      )}

      <DraftSheet
        draftId={selectedDraftId}
        onClose={() => setSelectedDraftId(null)}
        kbByNs={kbByNs}
        kbs={kbsQuery.data?.items ?? []}
        canReview={canReview}
        onChanged={invalidateDrafts}
      />
    </div>
  );
}

// ── zakładka: Luki wiedzy ───────────────────────────────────────────────────

function GapsTab({ search }: { search: InboxSearch }) {
  const navigate = useNavigate();
  const toast = useToast();
  const me = useMe();
  const canGaps = can(me.data?.user.role, 'gaps');

  const status = search.status ?? 'open';
  const page = search.page ?? 1;

  const updateSearch = (patch: SearchPatch): void => {
    void navigate({
      to: '/inbox',
      search: cleanSearch({ ...search, tab: 'gaps', page: undefined, ...patch }),
    });
  };

  const statsQuery = useQuery({
    queryKey: ['gaps', 'stats'],
    queryFn: () => apiFetch<GapStats>('/api/v1/learning/stats'),
  });

  const gapsQuery = useQuery({
    queryKey: ['gaps', { status, page }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      params.set('page', String(page));
      params.set('limit', String(PAGE_LIMIT));
      return apiFetchWithMeta<{ items: GapItem[] }>(`/api/v1/learning/gaps?${params.toString()}`);
    },
  });
  const gaps = gapsQuery.data?.data.items ?? [];
  const total = gapsQuery.data?.meta?.total;
  const hasNext = gaps.length === PAGE_LIMIT;

  const [ignoreGap, setIgnoreGap] = useState<GapItem | null>(null);

  const invalidateGaps = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['gaps'] });
  };

  const resolve = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/v1/learning/gaps/${id}/resolve`, { method: 'POST' }),
    onSuccess: () => {
      toast.show(t('inbox.gaps.toast.resolved'), 'ok');
      invalidateGaps();
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const ignore = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/v1/learning/gaps/${id}/ignore`, { method: 'POST' }),
    onSuccess: () => {
      setIgnoreGap(null);
      toast.show(t('inbox.gaps.toast.ignored'), 'ok');
      invalidateGaps();
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const startDraft = useMutation({
    mutationFn: (gap: GapItem) =>
      apiFetch<{ gap: GapItem; draftId: string; prefill: Record<string, unknown> }>(
        `/api/v1/learning/gaps/${gap.id}/start-draft`,
        { method: 'POST' },
      ),
    onSuccess: (_data, gap) => {
      toast.show(t('inbox.gaps.toast.draftStarted'), 'ok');
      invalidateGaps();
      void queryClient.invalidateQueries({ queryKey: ['drafts'] });
      // Prefill /add pytaniem z luki (lib/prefill — limit długości deep-linku).
      void navigate({ to: '/add', search: buildAddLinkSearch(gap.question) ?? {} });
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  // Bez useMemo — kolumny domykają się na świeżych mutacjach (isPending itd.).
  const columns: Column<GapItem>[] = (() => {
    const cols: Column<GapItem>[] = [
      {
        key: 'question',
        header: t('inbox.gaps.col.question'),
        render: (row) => <span className="font-medium text-text">{row.question}</span>,
      },
      {
        key: 'kb',
        header: t('inbox.gaps.col.kb'),
        render: (row) =>
          row.namespace !== null ? <code className="font-mono text-xs">{row.namespace}</code> : '—',
      },
      {
        key: 'confidence',
        header: t('inbox.gaps.col.confidence'),
        render: (row) => (
          <Badge variant={confidenceBadge(row.confidence).variant}>
            {Math.round(row.confidence * 100)}%
          </Badge>
        ),
      },
      {
        key: 'source',
        header: t('inbox.gaps.col.source'),
        hideBelow: 'md',
        render: (row) => gapSourceLabel(row.source),
      },
      {
        key: 'count',
        header: t('inbox.gaps.col.count'),
        hideBelow: 'md',
        align: 'right',
        render: (row) => formatNumber(row.evidenceCount),
      },
      {
        key: 'date',
        header: t('inbox.gaps.col.date'),
        hideBelow: 'sm',
        render: (row) => <span className="text-text-secondary">{formatDateTime(row.createdAt)}</span>,
      },
      {
        key: 'status',
        header: t('inbox.gaps.col.status'),
        render: (row) => gapStatusBadge(row.status),
      },
    ];
    if (canGaps) {
      cols.push({
        key: 'actions',
        header: '',
        align: 'right',
        render: (row) => <GapActionsMenu gap={row} />,
      });
    }
    return cols;
  })();

  /** Menu „…" akcji luki (Utwórz szkic / Rozwiązana / Ignoruj z AlertDialog). */
  function GapActionsMenu({ gap }: { gap: GapItem }) {
    const canCreate = gap.status === 'open';
    const canResolve = gap.status === 'open' || gap.status === 'in_draft';
    const canIgnore = gap.status === 'open';
    if (!canCreate && !canResolve && !canIgnore) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton aria-label={t('inbox.gaps.actions')} size="icon-sm">
            <MoreHorizontal size={16} aria-hidden="true" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canCreate && (
            <DropdownMenuItem
              disabled={startDraft.isPending}
              onSelect={() => startDraft.mutate(gap)}
            >
              <FilePlus2 size={16} aria-hidden="true" />
              {t('inbox.gaps.createDraft')}
            </DropdownMenuItem>
          )}
          {canResolve && (
            <DropdownMenuItem disabled={resolve.isPending} onSelect={() => resolve.mutate(gap.id)}>
              <Check size={16} aria-hidden="true" />
              {t('inbox.gaps.resolve')}
            </DropdownMenuItem>
          )}
          {canIgnore && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setIgnoreGap(gap)}>
                <X size={16} aria-hidden="true" />
                {t('inbox.gaps.ignore')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const stats = statsQuery.data?.stats;

  return (
    <div className="flex flex-col gap-4">
      {/* kafle statystyk = filtry statusu (klik aktywnego → wszystkie) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {GAP_STATUSES.map((key) => (
          <MetricTile
            key={key}
            label={t(GAP_STAT_LABEL_KEY[key])}
            value={stats !== undefined ? formatNumber(stats[key] ?? 0) : '…'}
            active={status === key}
            onClick={() =>
              updateSearch({ status: status === key ? 'all' : key === 'open' ? undefined : key })
            }
          />
        ))}
      </div>

      {gapsQuery.isError ? (
        <Alert variant="fail" title={errorMessage(gapsQuery.error)}>
          <Button className="mt-2" onClick={() => void gapsQuery.refetch()}>
            {t('common.retry')}
          </Button>
        </Alert>
      ) : (
        <DataTable
          columns={columns}
          rows={gaps}
          rowKey={(row) => row.id}
          loading={gapsQuery.isLoading}
          pagination={{
            page,
            pageSize: PAGE_LIMIT,
            ...(total !== undefined ? { total } : { hasNext }),
            onPageChange: (next) => updateSearch({ page: next > 1 ? next : undefined }),
          }}
          stickyHeader
          empty={
            <EmptyState
              icon={Check}
              title={t('inbox.gaps.empty.title')}
              description={t('inbox.gaps.empty.description')}
            />
          }
          mobileCard={(row) => (
            <div className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 text-sm font-medium text-text">{row.question}</span>
                {canGaps ? <GapActionsMenu gap={row} /> : gapStatusBadge(row.status)}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                {gapStatusBadge(row.status)}
                <Badge variant={confidenceBadge(row.confidence).variant}>
                  {Math.round(row.confidence * 100)}%
                </Badge>
                {row.namespace !== null && <code className="font-mono">{row.namespace}</code>}
                <span>{formatDateTime(row.createdAt)}</span>
              </div>
            </div>
          )}
        />
      )}

      {/* Ignoruj: AlertDialog destructive — brak reopen w API (nieodwracalne z panelu) */}
      <AlertDialog
        open={ignoreGap !== null}
        onOpenChange={(open) => !open && setIgnoreGap(null)}
        title={t('inbox.gaps.ignoreTitle')}
        objectName={ignoreGap?.question ?? ''}
        consequences={[t('inbox.gaps.ignoreConsequenceHide'), t('inbox.gaps.ignoreConsequenceNoUndo')]}
        confirmLabel={t('inbox.gaps.ignore')}
        destructive
        loading={ignore.isPending}
        onConfirm={() => ignoreGap !== null && ignore.mutate(ignoreGap.id)}
      />
    </div>
  );
}
