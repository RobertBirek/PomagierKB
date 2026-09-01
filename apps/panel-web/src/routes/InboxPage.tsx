import { useEffect, useMemo, useReducer, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { apiFetch, ApiError } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { can } from '../lib/permissions';
import { bulkSelectionReducer, allSelected } from '../lib/bulkSelection';
import { renderMarkdown } from '../lib/markdown';
import { useMe } from '../hooks/useMe';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { Modal } from '../components/Modal';
import { ConfirmButton } from '../components/ConfirmButton';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { t, formatDateTime, formatNumber } from '../i18n/t';
import type { PlKey } from '../i18n/pl';
import type { InboxSearch } from '../router';

/**
 * /inbox — dwie kolejki recenzji (human-in-the-loop):
 * - Szkice: lista draftów z filtrami w search-params (deep-linki), podgląd
 *   markdown, promote/reject/withdraw/edycja (pending), bulk dwufazowy
 *   (dryRun → raport per szkic → apply tylko ok);
 * - Luki wiedzy: kafle statystyk + tabela luk, akcje operatora
 *   (Utwórz szkic → prefill /add, Rozwiązana, Ignoruj).
 * Kontrakt API: apps/panel-api/src/routes/{drafts,learning}.ts.
 */

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

const GAP_STATUS_LABEL_KEY: Record<(typeof GAP_STATUSES)[number], PlKey> = {
  open: 'inbox.gaps.status.open',
  in_draft: 'inbox.gaps.status.in_draft',
  resolved: 'inbox.gaps.status.resolved',
  ignored: 'inbox.gaps.status.ignored',
};

const GAP_STAT_LABEL_KEY: Record<(typeof GAP_STATUSES)[number], PlKey> = {
  open: 'inbox.gaps.stat.open',
  in_draft: 'inbox.gaps.stat.in_draft',
  resolved: 'inbox.gaps.stat.resolved',
  ignored: 'inbox.gaps.stat.ignored',
};

// ── typy odpowiedzi API (services/drafts.ts, services/learning.ts) ──────────

interface DraftListItem {
  id: string;
  namespace: string;
  status: string;
  title: string;
  sourceType: string | null;
  sourceRef: string | null;
  documentCategory: string | null;
  tags: string[];
  contentLength: number | null;
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DraftDetail extends DraftListItem {
  contentMd: string | null;
  analysis: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

interface KbItem {
  namespace: string;
  name: string;
  status: string;
}

interface GapItem {
  id: string;
  question: string;
  source: string;
  namespace: string | null;
  confidence: number;
  evidenceCount: number;
  status: string;
  draftId: string | null;
  createdAt: string;
}

interface GapStats {
  stats: Record<string, number>;
  total: number;
}

interface BulkResult {
  id: string;
  ok: boolean;
  reason?: string;
}

interface BulkReport {
  op: 'promote' | 'reject';
  dryRun: boolean;
  results: BulkResult[];
  applied: number;
}

// ── słowniki etykiet (statusy spoza lib/status.ts: withdrawn + luki) ────────

function draftStatusBadge(status: string) {
  if (status === 'withdrawn') return <StatusBadge status={status} label={t('inbox.status.withdrawn')} variant="neutral" />;
  return <StatusBadge status={status} />;
}

function gapStatusBadge(status: string) {
  switch (status) {
    case 'open':
      return <StatusBadge status={status} label={t('inbox.gaps.status.open')} variant="warn" />;
    case 'in_draft':
      return <StatusBadge status={status} label={t('inbox.gaps.status.in_draft')} variant="accent" />;
    case 'resolved':
      return <StatusBadge status={status} label={t('inbox.gaps.status.resolved')} variant="ok" />;
    case 'ignored':
      return <StatusBadge status={status} label={t('inbox.gaps.status.ignored')} variant="neutral" />;
    default:
      return <StatusBadge status={status} />;
  }
}

function sourceLabel(sourceType: string | null): string {
  switch (sourceType) {
    case 'file':
      return t('inbox.source.file');
    case 'text':
      return t('inbox.source.text');
    case 'url':
      return t('inbox.source.url');
    case 'mcp':
      return t('inbox.source.mcp');
    case 'gap':
      return t('inbox.source.gap');
    default:
      return sourceType ?? '—';
  }
}

function gapSourceLabel(source: string): string {
  switch (source) {
    case 'mcp_kb_answer':
      return t('inbox.gaps.source.mcp_kb_answer');
    case 'ask':
      return t('inbox.gaps.source.ask');
    case 'feedback':
      return t('inbox.gaps.source.feedback');
    default:
      return source;
  }
}

/** Powód konfliktu bulka bywa prefiksowany kodem ('conflict: …') — pokazujemy część PL. */
function formatBulkReason(reason: string | undefined): string {
  if (reason === undefined || reason === '') return t('inbox.bulk.conflict');
  const match = /^[a-z_]+:\s*(.+)$/.exec(reason);
  return match?.[1] ?? reason;
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

// ── strona ──────────────────────────────────────────────────────────────────


export function InboxPage() {
  const search = useSearch({ from: '/inbox' });
  const tab = search.tab === 'gaps' ? 'gaps' : 'drafts';
  return (
    <div className="stack">
      <InboxTabs active={tab} />
      {tab === 'drafts' ? <DraftsTab search={search} /> : <GapsTab search={search} />}
    </div>
  );
}

function InboxTabs({ active }: { active: 'drafts' | 'gaps' }) {
  const navigate = useNavigate();
  const go = (tab: 'drafts' | 'gaps'): void => {
    // Zmiana zakładki resetuje filtry (statusy draftów i luk to inne słowniki).
    void navigate({ to: '/inbox', search: tab === 'gaps' ? { tab: 'gaps' } : {} });
  };
  return (
    <div className="tabs" role="tablist">
      <button
        type="button"
        role="tab"
        className={active === 'drafts' ? 'tab tab-active' : 'tab'}
        aria-selected={active === 'drafts'}
        onClick={() => go('drafts')}
      >
        {t('inbox.tab.drafts')}
      </button>
      <button
        type="button"
        role="tab"
        className={active === 'gaps' ? 'tab tab-active' : 'tab'}
        aria-selected={active === 'gaps'}
        onClick={() => go('gaps')}
      >
        {t('inbox.tab.gaps')}
      </button>
    </div>
  );
}

// ── zakładka: Szkice ────────────────────────────────────────────────────────

function DraftsTab({ search }: { search: InboxSearch }) {
  const navigate = useNavigate();
  const toast = useToast();
  const me = useMe();
  const role = me.data?.user.role;
  const canReview = can(role, 'inbox');

  const status = search.status ?? 'pending';
  const page = search.page ?? 1;
  const [qInput, setQInput] = useState(search.q ?? '');
  useEffect(() => setQInput(search.q ?? ''), [search.q]);

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
      return apiFetch<{ items: DraftListItem[] }>(`/api/v1/drafts?${params.toString()}`);
    },
  });
  const drafts = draftsQuery.data?.items ?? [];
  // apiFetch rozpakowuje kopertę bez meta — heurystyka „jest następna strona".
  const hasNext = drafts.length === PAGE_LIMIT;

  // Selekcja bulk — czysty reducer (lib/bulkSelection.ts).
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
  const [bulkState, setBulkState] = useState<{ op: 'promote' | 'reject'; report: BulkReport } | null>(null);

  const invalidateDrafts = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['drafts'] });
    void queryClient.invalidateQueries({ queryKey: ['kbs'] }); // liczniki pendingDrafts
  };

  const bulkDryRun = useMutation({
    mutationFn: (op: 'promote' | 'reject') =>
      apiFetch<BulkReport>('/api/v1/drafts/bulk', {
        method: 'POST',
        body: { op, ids: [...selected], dryRun: true },
      }),
    onSuccess: (report, op) => setBulkState({ op, report }),
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const bulkApply = useMutation({
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
      setBulkState(null);
      dispatchSelection({ type: 'clear' });
      invalidateDrafts();
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of drafts) map.set(d.id, d.title);
    return map;
  }, [drafts]);

  const columns = useMemo(() => {
    const cols: Column<DraftListItem>[] = [];
    if (canReview) {
      cols.push({
        key: 'select',
        header: t('inbox.col.select'),
        width: '36px',
        render: (row) =>
          row.status === 'pending' ? (
            <input
              type="checkbox"
              checked={selected.includes(row.id)}
              aria-label={t('inbox.selectDraft', { title: row.title })}
              onClick={(ev) => ev.stopPropagation()}
              onChange={() => dispatchSelection({ type: 'toggle', id: row.id })}
            />
          ) : null,
      });
    }
    cols.push(
      { key: 'title', header: t('inbox.col.title'), render: (row) => <strong>{row.title}</strong> },
      { key: 'kb', header: t('inbox.col.kb'), render: (row) => <code>{row.namespace}</code> },
      { key: 'category', header: t('inbox.col.category'), render: (row) => row.documentCategory ?? '—' },
      { key: 'source', header: t('inbox.col.source'), render: (row) => sourceLabel(row.sourceType) },
      {
        key: 'date',
        header: t('inbox.col.date'),
        render: (row) => <span className="muted">{formatDateTime(row.createdAt)}</span>,
      },
      { key: 'status', header: t('inbox.col.status'), render: (row) => draftStatusBadge(row.status) },
    );
    return cols;
  }, [canReview, selected]);

  const hasFilters = status !== 'pending' || search.kb !== undefined || search.q !== undefined;
  const emptyState = hasFilters ? (
    <EmptyState
      icon="🔍"
      title={t('inbox.empty.filteredTitle')}
      description={t('inbox.empty.filteredDescription')}
      action={
        <button type="button" className="btn" onClick={() => void navigate({ to: '/inbox', search: {} })}>
          {t('inbox.empty.clearFilters')}
        </button>
      }
    />
  ) : (
    <EmptyState
      icon="📥"
      title={t('inbox.empty.title')}
      description={t('inbox.empty.description')}
      action={
        <button type="button" className="btn btn-primary" onClick={() => void navigate({ to: '/add', search: {} })}>
          {t('inbox.empty.cta')}
        </button>
      }
    />
  );

  return (
    <div className="stack">
      {/* filtry — stan w search-params (deep-linki) */}
      <form
        className="filter-bar"
        onSubmit={(ev) => {
          ev.preventDefault();
          updateSearch({ q: qInput.trim() === '' ? undefined : qInput.trim() });
        }}
      >
        <label className="filter-field">
          <span className="muted">{t('inbox.filter.status')}</span>
          <select
            className="input"
            value={status}
            onChange={(ev) => updateSearch({ status: ev.target.value === 'pending' ? undefined : ev.target.value })}
          >
            {DRAFT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(DRAFT_STATUS_LABEL_KEY[s])}
              </option>
            ))}
            <option value="all">{t('inbox.filter.all')}</option>
          </select>
        </label>
        <label className="filter-field">
          <span className="muted">{t('inbox.filter.kb')}</span>
          <select
            className="input"
            value={search.kb ?? ''}
            onChange={(ev) => updateSearch({ kb: ev.target.value === '' ? undefined : ev.target.value })}
          >
            <option value="">{t('inbox.filter.all')}</option>
            {(kbsQuery.data?.items ?? []).map((kb) => (
              <option key={kb.namespace} value={kb.namespace}>
                {kb.name} ({kb.namespace})
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field grow">
          <span className="muted">{t('common.search')}</span>
          <input
            className="input"
            value={qInput}
            placeholder={t('inbox.filter.searchPlaceholder')}
            onChange={(ev) => setQInput(ev.target.value)}
          />
        </label>
        <button type="submit" className="btn">
          {t('common.search')}
        </button>
      </form>

      {/* pasek akcji zbiorczych */}
      {canReview && selected.length > 0 && (
        <div className="bulk-bar card row">
          <strong>{t('inbox.bulk.selected', { count: selected.length })}</strong>
          <button
            type="button"
            className="btn btn-sm"
            disabled={allSelected(selected, selectableIds)}
            onClick={() => dispatchSelection({ type: 'selectMany', ids: selectableIds })}
          >
            {t('inbox.bulk.selectPage')}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => dispatchSelection({ type: 'clear' })}>
            {t('inbox.bulk.clear')}
          </button>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={bulkDryRun.isPending}
            onClick={() => bulkDryRun.mutate('promote')}
          >
            {t('inbox.bulk.promote')}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={bulkDryRun.isPending}
            onClick={() => bulkDryRun.mutate('reject')}
          >
            {t('inbox.bulk.reject')}
          </button>
        </div>
      )}

      {draftsQuery.isLoading ? (
        <div className="stack">
          <Skeleton height="40px" />
          <Skeleton height="200px" />
        </div>
      ) : draftsQuery.isError ? (
        <div className="card stack">
          <span>{errorMessage(draftsQuery.error)}</span>
          <button type="button" className="btn" onClick={() => void draftsQuery.refetch()}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={drafts}
          rowKey={(row) => row.id}
          onRowClick={(row) => setSelectedDraftId(row.id)}
          page={page}
          pageCount={hasNext ? page + 1 : page}
          onPageChange={(next) => updateSearch({ page: next > 1 ? next : undefined })}
          empty={emptyState}
        />
      )}

      <DraftModal
        draftId={selectedDraftId}
        onClose={() => setSelectedDraftId(null)}
        kbByNs={kbByNs}
        kbs={kbsQuery.data?.items ?? []}
        canReview={canReview}
        onChanged={invalidateDrafts}
      />

      {/* modal bulk: raport dryRun per szkic → apply */}
      <Modal
        open={bulkState !== null}
        onClose={() => setBulkState(null)}
        title={bulkState?.op === 'reject' ? t('inbox.bulk.modalTitleReject') : t('inbox.bulk.modalTitlePromote')}
        wide
        footer={
          bulkState !== null && (
            <>
              <button type="button" className="btn" onClick={() => setBulkState(null)}>
                {t('common.cancel')}
              </button>
              {bulkState.report.results.some((r) => r.ok) ? (
                <button
                  type="button"
                  className={bulkState.op === 'reject' ? 'btn btn-danger' : 'btn btn-primary'}
                  disabled={bulkApply.isPending}
                  onClick={() => bulkApply.mutate(bulkState.op)}
                >
                  {t('inbox.bulk.apply', { count: bulkState.report.results.filter((r) => r.ok).length })}
                </button>
              ) : (
                <span className="muted">{t('inbox.bulk.nothingToApply')}</span>
              )}
            </>
          )
        }
      >
        {bulkState !== null && (
          <div className="stack">
            <p className="muted">{t('inbox.bulk.dryRunInfo')}</p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('inbox.bulk.colDraft')}</th>
                    <th>{t('inbox.bulk.colResult')}</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkState.report.results.map((result) => (
                    <tr key={result.id}>
                      <td>{titleById.get(result.id) ?? result.id}</td>
                      <td>
                        {result.ok ? (
                          <StatusBadge label={t('inbox.bulk.ok')} variant="ok" />
                        ) : (
                          <span className="row">
                            <StatusBadge label={t('inbox.bulk.conflict')} variant="fail" />
                            <span className="muted">{formatBulkReason(result.reason)}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ── modal podglądu / edycji szkicu ──────────────────────────────────────────

interface DraftModalProps {
  draftId: string | null;
  onClose: () => void;
  kbByNs: Map<string, KbItem>;
  kbs: KbItem[];
  canReview: boolean;
  onChanged: () => void;
}

interface DraftEditForm {
  title: string;
  tags: string;
  namespace: string;
  documentCategory: string;
}

function DraftModal({ draftId, onClose, kbByNs, kbs, canReview, onChanged }: DraftModalProps) {
  const toast = useToast();
  const [edit, setEdit] = useState<DraftEditForm | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    setEdit(null);
    setRejectReason('');
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
      apiFetch<{ draft: DraftListItem; resolvedGaps: number }>(`/api/v1/drafts/${id}/promote`, { method: 'POST' }),
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
        body: input.reason.trim() === '' ? {} : { reason: input.reason.trim() },
      }),
    onSuccess: () => done(t('inbox.toast.rejected'), 'warn'),
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const withdraw = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ draft: DraftListItem }>(`/api/v1/drafts/${id}/withdraw`, { method: 'POST' }),
    onSuccess: () => done(t('inbox.toast.withdrawn'), 'warn'),
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
          documentCategory: input.form.documentCategory.trim() === '' ? null : input.form.documentCategory.trim(),
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

  const kbActive = draft !== undefined && kbByNs.get(draft.namespace)?.status === 'active';
  const analysis = draft?.analysis ?? null;
  const analysisProvider =
    analysis !== null && typeof analysis['provider'] === 'string' ? analysis['provider'] : null;
  const analysisWarnings =
    analysis !== null && Array.isArray(analysis['warnings'])
      ? (analysis['warnings'] as unknown[]).filter((w): w is string => typeof w === 'string')
      : [];

  return (
    <Modal
      open={draftId !== null}
      onClose={onClose}
      title={draft?.title ?? t('inbox.draft.modalTitle')}
      wide
      footer={
        draft !== undefined && canReview && edit === null ? (
          <>
            {draft.status === 'pending' && (
              <button
                type="button"
                className="btn"
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
              </button>
            )}
            {draft.status === 'promoted' && (
              <ConfirmButton onConfirm={() => withdraw.mutate(draft.id)} disabled={withdraw.isPending}>
                {t('inbox.action.withdraw')}
              </ConfirmButton>
            )}
            {draft.status === 'pending' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!kbActive || promote.isPending}
                title={!kbActive ? t('inbox.action.promoteBlocked', { kb: draft.namespace }) : undefined}
                onClick={() => promote.mutate(draft.id)}
              >
                {t('inbox.action.promote')}
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {detailQuery.isLoading && (
        <div className="stack">
          <Skeleton height="18px" width="60%" />
          <Skeleton height="120px" />
        </div>
      )}
      {detailQuery.isError && <p>{errorMessage(detailQuery.error)}</p>}
      {draft !== undefined && (
        <div className="stack">
          <div className="row draft-meta">
            {draftStatusBadge(draft.status)}
            <code>{draft.namespace}</code>
            {analysisProvider !== null && (
              <StatusBadge label={t('inbox.draft.analysisProvider', { provider: analysisProvider })} variant="accent" />
            )}
            <span className="muted">{sourceLabel(draft.sourceType)}</span>
            <span className="muted">{formatDateTime(draft.createdAt)}</span>
            {draft.contentLength !== null && (
              <span className="muted">{t('inbox.draft.contentLength', { count: formatNumber(draft.contentLength) })}</span>
            )}
          </div>

          {analysisWarnings.length > 0 && (
            <div className="warning-box">
              <strong>{t('inbox.draft.analysisWarnings')}</strong>
              <ul>
                {analysisWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {draft.rejectReason !== null && draft.rejectReason !== '' && (
            <div className="warning-box">
              <strong>{t('inbox.draft.rejectReason')}</strong>
              <p>{draft.rejectReason}</p>
            </div>
          )}

          {edit !== null ? (
            <form
              className="stack"
              onSubmit={(ev) => {
                ev.preventDefault();
                patch.mutate({ id: draft.id, form: edit });
              }}
            >
              <label className="stack-tight">
                <span className="muted">{t('inbox.edit.title')}</span>
                <input
                  className="input"
                  value={edit.title}
                  required
                  onChange={(ev) => setEdit({ ...edit, title: ev.target.value })}
                />
              </label>
              <label className="stack-tight">
                <span className="muted">{t('inbox.edit.tags')}</span>
                <input
                  className="input"
                  value={edit.tags}
                  onChange={(ev) => setEdit({ ...edit, tags: ev.target.value })}
                />
              </label>
              <label className="stack-tight">
                <span className="muted">{t('inbox.edit.kb')}</span>
                <select
                  className="input"
                  value={edit.namespace}
                  onChange={(ev) => setEdit({ ...edit, namespace: ev.target.value })}
                >
                  {kbs.map((kb) => (
                    <option key={kb.namespace} value={kb.namespace} disabled={kb.status !== 'active'}>
                      {kb.name} ({kb.namespace})
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack-tight">
                <span className="muted">{t('inbox.edit.category')}</span>
                <input
                  className="input"
                  value={edit.documentCategory}
                  placeholder={t('inbox.edit.categoryPlaceholder')}
                  onChange={(ev) => setEdit({ ...edit, documentCategory: ev.target.value })}
                />
              </label>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={() => setEdit(null)}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={patch.isPending}>
                  {t('common.save')}
                </button>
              </div>
            </form>
          ) : (
            <>
              {draft.tags.length > 0 && (
                <div className="row draft-tags">
                  <span className="muted">{t('inbox.draft.tags')}:</span>
                  {draft.tags.map((tag) => (
                    <span key={tag} className="chip">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <section>
                <h3 className="section-title">{t('inbox.draft.content')}</h3>
                {draft.contentMd !== null && draft.contentMd !== '' ? (
                  // renderMarkdown escapuje CAŁE wejście przed transformacją (lib/markdown.ts)
                  <div className="draft-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.contentMd) }} />
                ) : (
                  <p className="muted">{t('inbox.draft.noContent')}</p>
                )}
              </section>
              {Object.keys(draft.metadata).length > 0 && (
                <details>
                  <summary className="muted">{t('inbox.draft.metadata')}</summary>
                  <pre className="log-pre">{JSON.stringify(draft.metadata, null, 2)}</pre>
                </details>
              )}
              {canReview && draft.status === 'pending' && (
                <div className="stack-tight">
                  <textarea
                    className="input"
                    rows={2}
                    value={rejectReason}
                    placeholder={t('inbox.action.rejectReasonPlaceholder')}
                    onChange={(ev) => setRejectReason(ev.target.value)}
                  />
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <ConfirmButton
                      onConfirm={() => reject.mutate({ id: draft.id, reason: rejectReason })}
                      disabled={reject.isPending}
                    >
                      {t('inbox.action.reject')}
                    </ConfirmButton>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
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
    void navigate({ to: '/inbox', search: cleanSearch({ ...search, tab: 'gaps', page: undefined, ...patch }) });
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
      return apiFetch<{ items: GapItem[] }>(`/api/v1/learning/gaps?${params.toString()}`);
    },
  });
  const gaps = gapsQuery.data?.items ?? [];
  const hasNext = gaps.length === PAGE_LIMIT;

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
      // Prefill /add pytaniem z luki (trasa /add przyjmuje ?question=).
      void navigate({ to: '/add', search: { question: gap.question } });
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const columns = useMemo(() => {
    const cols: Column<GapItem>[] = [
      { key: 'question', header: t('inbox.gaps.col.question'), render: (row) => <strong>{row.question}</strong> },
      {
        key: 'kb',
        header: t('inbox.gaps.col.kb'),
        render: (row) => (row.namespace !== null ? <code>{row.namespace}</code> : '—'),
      },
      {
        key: 'confidence',
        header: t('inbox.gaps.col.confidence'),
        render: (row) => `${Math.round(row.confidence * 100)}%`,
      },
      { key: 'source', header: t('inbox.gaps.col.source'), render: (row) => gapSourceLabel(row.source) },
      { key: 'count', header: t('inbox.gaps.col.count'), render: (row) => formatNumber(row.evidenceCount) },
      {
        key: 'date',
        header: t('inbox.gaps.col.date'),
        render: (row) => <span className="muted">{formatDateTime(row.createdAt)}</span>,
      },
      { key: 'status', header: t('inbox.gaps.col.status'), render: (row) => gapStatusBadge(row.status) },
    ];
    if (canGaps) {
      cols.push({
        key: 'actions',
        header: t('kb.col.actions'),
        render: (row) => (
          <div className="row" onClick={(ev) => ev.stopPropagation()}>
            {row.status === 'open' && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={startDraft.isPending}
                onClick={() => startDraft.mutate(row)}
              >
                {t('inbox.gaps.createDraft')}
              </button>
            )}
            {(row.status === 'open' || row.status === 'in_draft') && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate(row.id)}
              >
                {t('inbox.gaps.resolve')}
              </button>
            )}
            {row.status === 'open' && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={ignore.isPending}
                onClick={() => ignore.mutate(row.id)}
              >
                {t('inbox.gaps.ignore')}
              </button>
            )}
          </div>
        ),
      });
    }
    return cols;
  }, [canGaps, startDraft.isPending, resolve.isPending, ignore.isPending]);

  const stats = statsQuery.data?.stats;

  return (
    <div className="stack">
      {/* kafle statystyk open/in_draft/resolved/ignored */}
      <div className="stat-tiles">
        {GAP_STATUSES.map((key) => (
          <button
            key={key}
            type="button"
            className={status === key ? 'stat-tile stat-tile-active' : 'stat-tile'}
            onClick={() => updateSearch({ status: key === 'open' ? undefined : key })}
          >
            <span className="stat-tile-value">{stats !== undefined ? formatNumber(stats[key] ?? 0) : '…'}</span>
            <span className="muted">{t(GAP_STAT_LABEL_KEY[key])}</span>
          </button>
        ))}
      </div>

      <div className="row">
        <label className="filter-field">
          <span className="muted">{t('inbox.filter.status')}</span>
          <select
            className="input"
            value={status}
            onChange={(ev) => updateSearch({ status: ev.target.value === 'open' ? undefined : ev.target.value })}
          >
            {GAP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(GAP_STATUS_LABEL_KEY[s])}
              </option>
            ))}
            <option value="all">{t('inbox.filter.all')}</option>
          </select>
        </label>
      </div>

      {gapsQuery.isLoading ? (
        <div className="stack">
          <Skeleton height="40px" />
          <Skeleton height="160px" />
        </div>
      ) : gapsQuery.isError ? (
        <div className="card stack">
          <span>{errorMessage(gapsQuery.error)}</span>
          <button type="button" className="btn" onClick={() => void gapsQuery.refetch()}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={gaps}
          rowKey={(row) => row.id}
          page={page}
          pageCount={hasNext ? page + 1 : page}
          onPageChange={(next) => updateSearch({ page: next > 1 ? next : undefined })}
          empty={
            <EmptyState
              icon="✅"
              title={t('inbox.gaps.empty.title')}
              description={t('inbox.gaps.empty.description')}
            />
          }
        />
      )}
    </div>
  );
}
