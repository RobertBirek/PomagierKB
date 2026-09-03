import { useState } from 'react';
import { version as reactVersion } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { apiFetch, ApiError } from '../lib/api';
import { coerceNumberSetting, groupByDay, maskSecret } from '../lib/settingsView';
import { useMe } from '../hooks/useMe';
import { useStatus } from '../hooks/useStatus';
import { t, formatDateTime, type PlKey } from '../i18n/t';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { ConfirmButton } from '../components/ConfirmButton';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import type { SettingsTab } from '../router';

/**
 * Strona /settings (admin): LLM (sekrety maskowane, test połączenia,
 * niezmienność embeddingów), Progi, System (akcje z logTail, audyt z weryfikacją
 * łańcucha, health + breakery) i Diagnostyka. Kontrakt:
 * apps/panel-api/src/routes/{settings,actions,audit,status}.ts.
 * Status backupów pominięty świadomie — panel-api nie ma takiego endpointu.
 */

// ── Kształty API ─────────────────────────────────────────────────────────────

interface MaskedSettingDto {
  configured: boolean;
  /** Tylko sekrety: zamaskowany podgląd (np. 'ab***yz'), nigdy pełna wartość. */
  preview?: string;
  /** Tylko ustawienia jawne: pełna wartość. */
  value?: unknown;
  updatedAt?: string;
  updatedBy?: string | null;
}

type SettingsMap = Record<string, MaskedSettingDto | undefined>;

interface TestLlmResult {
  ok: boolean;
  model: string;
  latencyMs: number;
}

interface ActionDto {
  id: string;
  type: string;
  resource: string | null;
  status: string;
  statusLabel: string;
  params: Record<string, unknown>;
  progress: Record<string, unknown> | null;
  startedBy: string | null;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}

interface ActionDetailsDto extends ActionDto {
  logTail: string[];
}

interface AuditEntryDto {
  seq: number;
  id: string;
  at: string;
  actor: string;
  actorType: string;
  role: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
}

interface VerifyChainDto {
  valid: boolean;
  checked: number;
  firstBrokenSeq?: number;
  problems: { seq: number; kind: string }[];
}

interface BreakerDto {
  name: string;
  state: string;
  reason?: string | null;
  retryAfter?: string | null;
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => apiFetch<SettingsMap>('/api/v1/settings') });
}

// ── Zakładka LLM ─────────────────────────────────────────────────────────────

type LlmTarget = 'chat' | 'openie' | 'embeddings';

function LlmForm({
  target,
  titleKey,
  descKey,
  setting,
  locked,
}: {
  target: LlmTarget;
  titleKey: PlKey;
  descKey: PlKey;
  setting: MaskedSettingDto | undefined;
  /** Embeddingi przy ≥1 aktywnej KB — formularz tylko do odczytu. */
  locked: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');

  const save = useMutation({
    mutationFn: () =>
      apiFetch<MaskedSettingDto>(`/api/v1/settings/llm.${target}`, {
        method: 'PUT',
        body: { value: { baseUrl: baseUrl.trim(), model: model.trim(), apiKey } },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.show(t('settings.llm.saved'), 'ok');
      setApiKey('');
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  const test = useMutation({
    mutationFn: () =>
      apiFetch<TestLlmResult>('/api/v1/settings/test-llm', { method: 'POST', body: { target } }),
  });

  const configured = setting?.configured === true;
  const keyStatus = configured
    ? t('settings.llm.keyConfigured', { preview: setting?.preview ?? '***' })
    : t('settings.llm.keyNotConfigured');
  const canSave = !locked && baseUrl.trim() !== '' && model.trim() !== '';

  return (
    <div className="card stack">
      <div className="row">
        <h3 style={{ margin: 0 }}>{t(titleKey)}</h3>
        <span className="grow" />
        <StatusBadge
          variant={configured ? 'ok' : 'neutral'}
          label={configured ? keyStatus : t('settings.llm.keyNotConfigured')}
        />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t(descKey)}
      </p>

      {target === 'embeddings' && <p className="callout callout-warn">{t('settings.llm.embeddingsWarning')}</p>}
      {locked && <p className="callout callout-fail">{t('settings.llm.embeddingsLocked')}</p>}

      {!locked && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            {t('settings.llm.overwriteHint')}
          </p>
          <div className="form-grid">
            <label className="field">
              <span>{t('settings.llm.baseUrl')}</span>
              <input
                className="input"
                value={baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(ev) => setBaseUrl(ev.target.value)}
              />
            </label>
            <label className="field">
              <span>{t('settings.llm.model')}</span>
              <input className="input" value={model} onChange={(ev) => setModel(ev.target.value)} />
            </label>
            <label className="field">
              <span>{t('settings.llm.apiKey')}</span>
              <input
                className="input"
                type="password"
                value={apiKey}
                autoComplete="off"
                placeholder={configured ? t('settings.llm.keyKeepHint') : ''}
                onChange={(ev) => setApiKey(ev.target.value)}
              />
              <span className="muted">
                {apiKey !== ''
                  ? t('settings.llm.willSaveAs', { preview: maskSecret(apiKey) })
                  : t('settings.llm.keyKeepHint')}
              </span>
            </label>
          </div>
        </>
      )}

      <div className="row">
        {!locked && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSave || save.isPending}
            title={canSave ? undefined : t('settings.llm.requiredHint')}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={test.isPending || !configured}
          onClick={() => test.mutate()}
        >
          {test.isPending ? t('common.loading') : t('settings.llm.test')}
        </button>
        <span className="grow" />
        {setting?.updatedAt !== undefined && (
          <span className="muted">{t('settings.llm.updatedAt', { at: formatDateTime(setting.updatedAt) })}</span>
        )}
      </div>

      {test.isSuccess && (
        <p className="callout callout-ok">
          {t('settings.llm.testOk', { model: test.data.model, ms: test.data.latencyMs })}
        </p>
      )}
      {test.isError && <p className="callout callout-fail">{errMsg(test.error)}</p>}
    </div>
  );
}

function LlmTab() {
  const settings = useSettings();
  const kbs = useQuery({
    queryKey: ['kbs'],
    queryFn: () => apiFetch<{ items: { namespace: string; status: string }[] }>('/api/v1/kbs'),
  });

  if (settings.isPending || kbs.isPending) return <Skeleton height="240px" />;
  if (settings.isError) {
    return (
      <EmptyState
        icon="⚠️"
        title={t('common.error')}
        description={errMsg(settings.error)}
        action={
          <button type="button" className="btn btn-primary" onClick={() => void settings.refetch()}>
            {t('common.retry')}
          </button>
        }
      />
    );
  }

  // Model embeddingów jest niezmienialny po utworzeniu bazy — przy ≥1 aktywnej
  // KB formularz przechodzi w tryb tylko-do-odczytu (docs: pipeline-frontend §e).
  const hasActiveKb = (kbs.data?.items ?? []).some((kb) => kb.status === 'active');

  return (
    <div className="stack">
      <LlmForm
        target="chat"
        titleKey="settings.llm.chatTitle"
        descKey="settings.llm.chatDesc"
        setting={settings.data['llm.chat']}
        locked={false}
      />
      <LlmForm
        target="openie"
        titleKey="settings.llm.openieTitle"
        descKey="settings.llm.openieDesc"
        setting={settings.data['llm.openie']}
        locked={false}
      />
      <LlmForm
        target="embeddings"
        titleKey="settings.llm.embeddingsTitle"
        descKey="settings.llm.embeddingsDesc"
        setting={settings.data['llm.embeddings']}
        locked={hasActiveKb}
      />
    </div>
  );
}

// ── Zakładka Progi ───────────────────────────────────────────────────────────

const LEARNING_THRESHOLD_DEFAULT = 0.45;
const ANSWER_MIN_SCORE_DEFAULT = 0.01;

function ThresholdsTab() {
  const settings = useSettings();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<number | null>(null);

  const save = useMutation({
    mutationFn: (value: number) =>
      apiFetch<MaskedSettingDto>('/api/v1/settings/learning.threshold', { method: 'PUT', body: { value } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.show(t('settings.thresholds.saved'), 'ok');
      setDraft(null);
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  if (settings.isPending) return <Skeleton height="180px" />;
  if (settings.isError) {
    return <EmptyState icon="⚠️" title={t('common.error')} description={errMsg(settings.error)} />;
  }

  const stored = coerceNumberSetting(settings.data['learning.threshold']?.value, LEARNING_THRESHOLD_DEFAULT);
  const value = draft ?? stored;

  return (
    <div className="stack">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>{t('settings.thresholds.learningTitle')}</h3>
        <p className="muted" style={{ margin: 0 }}>
          {t('settings.thresholds.learningDesc')}
        </p>
        <div className="row">
          <input
            className="grow"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={value}
            aria-label={t('settings.thresholds.learningTitle')}
            onChange={(ev) => setDraft(Number(ev.target.value))}
          />
          <strong style={{ minWidth: 96 }}>{t('settings.thresholds.value', { value: value.toFixed(2) })}</strong>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={draft === null || draft === stored || save.isPending}
            onClick={() => {
              if (draft !== null) save.mutate(draft);
            }}
          >
            {t('common.save')}
          </button>
          <span className="muted">{t('settings.thresholds.default', { value: LEARNING_THRESHOLD_DEFAULT })}</span>
        </div>
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>{t('settings.thresholds.minScoreTitle')}</h3>
        <p className="muted" style={{ margin: 0 }}>
          {t('settings.thresholds.minScoreDesc')}
        </p>
        <div className="row">
          <input className="grow" type="range" min={0} max={0.05} step={0.001} value={ANSWER_MIN_SCORE_DEFAULT} disabled />
          <strong style={{ minWidth: 96 }}>
            {t('settings.thresholds.value', { value: ANSWER_MIN_SCORE_DEFAULT })}
          </strong>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t('settings.thresholds.minScoreReadOnly')}
        </p>
      </div>
    </div>
  );
}

// ── Zakładka System: akcje ───────────────────────────────────────────────────

const ACTION_STATUS_OPTIONS: { value: string; labelKey: PlKey }[] = [
  { value: 'running', labelKey: 'status.running' },
  { value: 'success', labelKey: 'status.done' },
  { value: 'error', labelKey: 'status.failed' },
  { value: 'cancelled', labelKey: 'status.canceled' },
];

const ACTIONS_PAGE_LIMIT = 20;

function ActionDetailsDrawer({ actionId, onClose }: { actionId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const details = useQuery({
    queryKey: ['action', actionId],
    queryFn: () => apiFetch<ActionDetailsDto>(`/api/v1/actions/${actionId}`),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });

  const cancel = useMutation({
    mutationFn: () => apiFetch<ActionDto>(`/api/v1/actions/${actionId}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['action', actionId] });
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      toast.show(t('system.actions.cancelSent'), 'ok');
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  const data = details.data;
  return (
    <Drawer open onClose={onClose} title={t('system.actions.detailsTitle', { id: actionId })}>
      {details.isPending && <Skeleton height="160px" />}
      {details.isError && <p className="callout callout-fail">{errMsg(details.error)}</p>}
      {data !== undefined && (
        <div className="stack">
          <div className="row">
            <StatusBadge status={data.status} label={data.statusLabel} />
            <span className="muted">{data.type}</span>
            {data.resource !== null && <code>{data.resource}</code>}
          </div>
          <div className="muted">
            {t('system.actions.startedAt')}: {formatDateTime(data.startedAt)}
            {data.finishedAt !== null && (
              <>
                {' · '}
                {t('system.actions.finishedAt')}: {formatDateTime(data.finishedAt)}
              </>
            )}
            {data.exitCode !== null && <> · {t('system.actions.exitCode', { code: data.exitCode })}</>}
          </div>
          {data.status === 'running' && (
            <div className="row">
              <ConfirmButton className="btn btn-danger btn-sm" onConfirm={() => cancel.mutate()}>
                {t('system.actions.cancel')}
              </ConfirmButton>
            </div>
          )}
          {data.progress !== null && (
            <div className="stack" style={{ gap: 4 }}>
              <strong>{t('system.actions.progress')}</strong>
              <pre className="code-block">{JSON.stringify(data.progress, null, 2)}</pre>
            </div>
          )}
          <div className="stack grow" style={{ gap: 4 }}>
            <strong>{t('system.actions.log')}</strong>
            {data.logTail.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {t('system.actions.logEmpty')}
              </p>
            ) : (
              <pre className="code-block log-tail">{data.logTail.join('\n')}</pre>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function ActionsSection() {
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (status !== '') params.set('status', status);
  if (type.trim() !== '') params.set('type', type.trim());
  params.set('page', String(page));
  params.set('limit', String(ACTIONS_PAGE_LIMIT));

  const actions = useQuery({
    queryKey: ['actions', { status, type: type.trim(), page }],
    queryFn: () => apiFetch<{ items: ActionDto[] }>(`/api/v1/actions?${params.toString()}`),
  });

  const items = actions.data?.items ?? [];
  // Koperta meta (total) jest poza apiFetch — pager heurystycznie: pełna strona = jest następna.
  const pageCount = items.length === ACTIONS_PAGE_LIMIT ? page + 1 : page;

  const columns: readonly Column<ActionDto>[] = [
    { key: 'type', header: t('system.actions.type'), render: (a) => a.type },
    { key: 'resource', header: t('system.actions.resource'), render: (a) => a.resource ?? '—' },
    {
      key: 'status',
      header: t('mcp.keys.status'),
      render: (a) => <StatusBadge status={a.status} label={a.statusLabel} />,
    },
    { key: 'startedBy', header: t('system.actions.startedBy'), render: (a) => a.startedBy ?? '—' },
    { key: 'startedAt', header: t('system.actions.startedAt'), render: (a) => formatDateTime(a.startedAt) },
    {
      key: 'finishedAt',
      header: t('system.actions.finishedAt'),
      render: (a) => (a.finishedAt !== null ? formatDateTime(a.finishedAt) : '—'),
    },
  ];

  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>{t('system.actions.title')}</h3>
      <div className="row filters-row">
        <label className="field">
          <span>{t('system.actions.filterStatus')}</span>
          <select
            className="input"
            value={status}
            onChange={(ev) => {
              setStatus(ev.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('system.actions.all')}</option>
            {ACTION_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>{t('system.actions.filterType')}</span>
          <input
            className="input"
            value={type}
            onChange={(ev) => {
              setType(ev.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      {actions.isPending ? (
        <Skeleton height="140px" />
      ) : actions.isError ? (
        <p className="callout callout-fail">{errMsg(actions.error)}</p>
      ) : (
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(a) => a.id}
          page={page}
          pageCount={pageCount}
          onPageChange={setPage}
          onRowClick={(a) => setOpenId(a.id)}
          empty={
            <EmptyState icon="🛠️" title={t('system.actions.emptyTitle')} description={t('system.actions.emptyDesc')} />
          }
        />
      )}
      {openId !== null && <ActionDetailsDrawer actionId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// ── Zakładka System: audyt ───────────────────────────────────────────────────

const AUDIT_PAGE_LIMIT = 50;

interface AuditFilters {
  from: string;
  to: string;
  action: string;
  actor: string;
  outcome: string;
}

function buildAuditQuery(filters: AuditFilters, beforeSeq: number | null): string {
  const params = new URLSearchParams();
  if (filters.from !== '') params.set('from', filters.from);
  if (filters.to !== '') params.set('to', `${filters.to}T23:59:59.999Z`);
  if (filters.action.trim() !== '') params.set('action', filters.action.trim());
  if (filters.actor.trim() !== '') params.set('actor', filters.actor.trim());
  if (filters.outcome !== '') params.set('outcome', filters.outcome);
  if (beforeSeq !== null) params.set('beforeSeq', String(beforeSeq));
  params.set('limit', String(AUDIT_PAGE_LIMIT));
  return params.toString();
}

function AuditEntryDrawer({ entry, onClose }: { entry: AuditEntryDto; onClose: () => void }) {
  return (
    <Drawer open onClose={onClose} title={t('system.audit.detailsTitle', { seq: entry.seq })}>
      <div className="stack">
        <div className="row">
          <StatusBadge
            variant={entry.outcome === 'success' ? 'ok' : 'fail'}
            label={entry.outcome === 'success' ? t('system.audit.outcomeSuccess') : t('system.audit.outcomeError')}
          />
          <code>{entry.action}</code>
        </div>
        <div className="muted">
          {formatDateTime(entry.at)} · {entry.actor} ({entry.actorType}
          {entry.role !== null ? `, ${entry.role}` : ''})
        </div>
        {entry.resourceType !== null && (
          <div className="muted">
            {t('system.audit.resource')}: {entry.resourceType}
            {entry.resourceId !== null ? ` / ${entry.resourceId}` : ''}
          </div>
        )}
        {entry.before !== null && (
          <div className="stack" style={{ gap: 4 }}>
            <strong>{t('system.audit.before')}</strong>
            <pre className="code-block">{JSON.stringify(entry.before, null, 2)}</pre>
          </div>
        )}
        {entry.after !== null && (
          <div className="stack" style={{ gap: 4 }}>
            <strong>{t('system.audit.after')}</strong>
            <pre className="code-block">{JSON.stringify(entry.after, null, 2)}</pre>
          </div>
        )}
        {entry.metadata !== null && (
          <div className="stack" style={{ gap: 4 }}>
            <strong>{t('system.audit.metadata')}</strong>
            <pre className="code-block">{JSON.stringify(entry.metadata, null, 2)}</pre>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function AuditSection() {
  const [filters, setFilters] = useState<AuditFilters>({ from: '', to: '', action: '', actor: '', outcome: '' });
  // Stos kursorów: wejście w „starsze" odkłada bieżący kursor, „najnowsze" czyści.
  const [cursorStack, setCursorStack] = useState<number[]>([]);
  const beforeSeq = cursorStack.length > 0 ? (cursorStack[cursorStack.length - 1] ?? null) : null;
  const [openEntry, setOpenEntry] = useState<AuditEntryDto | null>(null);

  const audit = useQuery({
    queryKey: ['audit', filters, beforeSeq],
    queryFn: () => apiFetch<AuditEntryDto[]>(`/api/v1/audit?${buildAuditQuery(filters, beforeSeq)}`),
  });

  const verify = useMutation({
    mutationFn: () => apiFetch<VerifyChainDto>('/api/v1/audit/verify'),
  });

  function setFilter<K extends keyof AuditFilters>(key: K, value: string): void {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setCursorStack([]);
  }

  const items = audit.data ?? [];
  const lastSeq = items.length > 0 ? (items[items.length - 1]?.seq ?? null) : null;
  const hasOlder = items.length === AUDIT_PAGE_LIMIT && lastSeq !== null;
  const groups = groupByDay(items);

  const columns: readonly Column<AuditEntryDto>[] = [
    { key: 'at', header: t('system.audit.time'), render: (e) => formatDateTime(e.at) },
    { key: 'actor', header: t('system.audit.actor'), render: (e) => e.actor },
    { key: 'action', header: t('system.audit.action'), render: (e) => <code>{e.action}</code> },
    {
      key: 'resource',
      header: t('system.audit.resource'),
      render: (e) =>
        e.resourceType !== null ? `${e.resourceType}${e.resourceId !== null ? ` / ${e.resourceId}` : ''}` : '—',
    },
    {
      key: 'outcome',
      header: t('system.audit.outcome'),
      render: (e) => (
        <StatusBadge
          variant={e.outcome === 'success' ? 'ok' : 'fail'}
          label={e.outcome === 'success' ? t('system.audit.outcomeSuccess') : t('system.audit.outcomeError')}
        />
      ),
    },
  ];

  return (
    <div className="card stack">
      <div className="row">
        <h3 style={{ margin: 0 }}>{t('system.audit.title')}</h3>
        <span className="grow" />
        <button type="button" className="btn" disabled={verify.isPending} onClick={() => verify.mutate()}>
          {verify.isPending ? t('common.loading') : t('system.audit.verify')}
        </button>
      </div>

      {verify.isSuccess &&
        (verify.data.valid ? (
          <p className="callout callout-ok">{t('system.audit.verifyOk', { checked: verify.data.checked })}</p>
        ) : (
          <p className="callout callout-fail">
            {t('system.audit.verifyFail', {
              problems: verify.data.problems.length,
              seq: verify.data.firstBrokenSeq ?? '—',
            })}
          </p>
        ))}
      {verify.isError && <p className="callout callout-fail">{errMsg(verify.error)}</p>}

      <div className="row filters-row">
        <label className="field">
          <span>{t('system.audit.from')}</span>
          <input className="input" type="date" value={filters.from} onChange={(ev) => setFilter('from', ev.target.value)} />
        </label>
        <label className="field">
          <span>{t('system.audit.to')}</span>
          <input className="input" type="date" value={filters.to} onChange={(ev) => setFilter('to', ev.target.value)} />
        </label>
        <label className="field">
          <span>{t('system.audit.action')}</span>
          <input className="input" value={filters.action} onChange={(ev) => setFilter('action', ev.target.value)} />
        </label>
        <label className="field">
          <span>{t('system.audit.actor')}</span>
          <input className="input" value={filters.actor} onChange={(ev) => setFilter('actor', ev.target.value)} />
        </label>
        <label className="field">
          <span>{t('system.audit.outcome')}</span>
          <select className="input" value={filters.outcome} onChange={(ev) => setFilter('outcome', ev.target.value)}>
            <option value="">{t('system.actions.all')}</option>
            <option value="success">{t('system.audit.outcomeSuccess')}</option>
            <option value="error">{t('system.audit.outcomeError')}</option>
          </select>
        </label>
      </div>

      {audit.isPending ? (
        <Skeleton height="140px" />
      ) : audit.isError ? (
        <p className="callout callout-fail">{errMsg(audit.error)}</p>
      ) : items.length === 0 ? (
        <EmptyState icon="📜" title={t('system.audit.emptyTitle')} description={t('system.audit.emptyDesc')} />
      ) : (
        <div className="stack">
          {groups.map((group) => (
            <div key={group.day} className="stack" style={{ gap: 6 }}>
              <div className="audit-day">{group.day}</div>
              <DataTable
                columns={columns}
                rows={group.items}
                rowKey={(e) => String(e.seq)}
                onRowClick={setOpenEntry}
              />
            </div>
          ))}
          <div className="row">
            {cursorStack.length > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => setCursorStack([])}>
                {t('system.audit.newest')}
              </button>
            )}
            <span className="grow" />
            {hasOlder && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  if (lastSeq !== null) setCursorStack((prev) => [...prev, lastSeq]);
                }}
              >
                {t('system.audit.older')}
              </button>
            )}
          </div>
        </div>
      )}
      {openEntry !== null && <AuditEntryDrawer entry={openEntry} onClose={() => setOpenEntry(null)} />}
    </div>
  );
}

// ── Zakładka System: health + breakery ───────────────────────────────────────

function breakerBadge(state: string): { variant: 'ok' | 'warn' | 'fail'; labelKey: PlKey } {
  if (state === 'open') return { variant: 'fail', labelKey: 'system.breakers.stateOpen' };
  if (state === 'half_open') return { variant: 'warn', labelKey: 'system.breakers.stateHalfOpen' };
  return { variant: 'ok', labelKey: 'system.breakers.stateClosed' };
}

function HealthSection() {
  const status = useStatus();
  const queryClient = useQueryClient();
  const toast = useToast();

  const reset = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ breakers: BreakerDto[] }>(`/api/v1/status/breakers/${encodeURIComponent(name)}/reset`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      toast.show(t('system.breakers.resetDone'), 'ok');
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  if (status.isPending) return <Skeleton height="200px" />;
  if (status.isError || status.data === undefined) {
    return <p className="callout callout-fail">{errMsg(status.error)}</p>;
  }

  const cockpit = status.data;
  const breakers = (cockpit.breakers ?? []) as BreakerDto[];

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h3 style={{ margin: 0 }}>{t('system.health.title')}</h3>
          <span className="grow" />
          <StatusBadge status={cockpit.overall} />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('system.health.component')}</th>
                <th>{t('mcp.keys.status')}</th>
                <th>{t('system.health.detail')}</th>
                <th>{t('system.health.latency')}</th>
              </tr>
            </thead>
            <tbody>
              {cockpit.components.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="muted">{c.detail}</td>
                  <td>{c.latencyMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t('system.health.generatedAt', { at: formatDateTime(cockpit.generatedAt) })}
        </p>
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>{t('system.breakers.title')}</h3>
        {breakers.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('system.breakers.emptyDesc')}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('system.breakers.name')}</th>
                  <th>{t('system.breakers.state')}</th>
                  <th>{t('system.breakers.reason')}</th>
                  <th>{t('system.breakers.retryAfter')}</th>
                  <th>{t('mcp.keys.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {breakers.map((b) => {
                  const badge = breakerBadge(b.state);
                  return (
                    <tr key={b.name}>
                      <td>
                        <code>{b.name}</code>
                      </td>
                      <td>
                        <StatusBadge variant={badge.variant} label={t(badge.labelKey)} />
                      </td>
                      <td className="muted">{b.reason ?? '—'}</td>
                      <td>
                        {b.retryAfter !== null && b.retryAfter !== undefined ? formatDateTime(b.retryAfter) : '—'}
                      </td>
                      <td>
                        {b.state !== 'closed' && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={reset.isPending}
                            onClick={() => reset.mutate(b.name)}
                          >
                            {t('system.breakers.reset')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SystemTab() {
  return (
    <div className="stack">
      <ActionsSection />
      <AuditSection />
      <HealthSection />
    </div>
  );
}

// ── Zakładka Diagnostyka ─────────────────────────────────────────────────────

function DiagTab() {
  const me = useMe();
  return (
    <div className="stack">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>{t('settings.diag.openapiTitle')}</h3>
        <p className="muted" style={{ margin: 0 }}>
          {t('settings.diag.openapiDesc')}
        </p>
        <div className="row">
          <a className="btn" href="/openapi.json" target="_blank" rel="noopener noreferrer">
            {t('settings.diag.openapiLink')}
          </a>
        </div>
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>{t('settings.diag.versionsTitle')}</h3>
        <p className="muted" style={{ margin: 0 }}>
          {t('settings.diag.react', { version: reactVersion })}
        </p>
        <p className="muted" style={{ margin: 0 }}>
          {t('settings.diag.mode', {
            mode: import.meta.env.PROD ? t('settings.diag.modeProd') : t('settings.diag.modeDev'),
          })}
        </p>
        {me.data !== undefined && (
          <p className="muted" style={{ margin: 0 }}>
            {t('settings.diag.session', { at: formatDateTime(me.data.session.expiresAt) })}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Strona ───────────────────────────────────────────────────────────────────

const TAB_LABEL: Record<SettingsTab, PlKey> = {
  llm: 'settings.tabs.llm',
  thresholds: 'settings.tabs.thresholds',
  system: 'settings.tabs.system',
  diag: 'settings.tabs.diag',
  // zakładki Fazy 3 (trasa już je przyjmuje; UI dodaje agent /settings)
  audit: 'settings.tabs.audit',
  health: 'settings.tabs.health',
};

const SETTINGS_TABS: readonly SettingsTab[] = ['llm', 'thresholds', 'system', 'diag'];

export function SettingsPage() {
  const search = useSearch({ from: '/settings' });
  const navigate = useNavigate();
  const tab: SettingsTab = search.tab ?? 'llm';

  function goTab(next: SettingsTab): void {
    void navigate({ to: '/settings', search: next === 'llm' ? {} : { tab: next } });
  }

  return (
    <div className="stack">
      <h1 className="page-title">{t('nav.settings')}</h1>
      <div className="tabs" role="tablist">
        {SETTINGS_TABS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? 'tab tab-active' : 'tab'}
            onClick={() => goTab(item)}
          >
            {t(TAB_LABEL[item])}
          </button>
        ))}
      </div>
      {tab === 'llm' && <LlmTab />}
      {tab === 'thresholds' && <ThresholdsTab />}
      {tab === 'system' && <SystemTab />}
      {tab === 'diag' && <DiagTab />}
    </div>
  );
}
