import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { can } from '../lib/permissions';
import {
  groupPreflightChecks,
  preflightCheckLabelKey,
  type PreflightCheck,
} from '../lib/preflight';
import {
  isValidNamespace,
  namespaceProblem,
  suggestNamespace,
  type NamespaceProblem,
} from '../lib/namespace';
import { useMe } from '../hooks/useMe';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { Modal } from '../components/Modal';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { ActionProgress } from '../components/ActionProgress';
import { statusLabel } from '../lib/status';
import { t, formatDateTime, formatNumber } from '../i18n/t';
import type { PlKey } from '../i18n/pl';
import type { ActionState } from '../hooks/useAction';

/**
 * /kb — rejestr baz wiedzy (jedyne źródło prawdy: SQLite przez panel-api):
 * tabela z totalsami i chipem dirty („wymaga builda"), akcje wg roli:
 * Build (preflight → build 202 → obserwacja akcji), Quality, Szczegóły
 * (drawer: historia buildów per plik, wersja schematu, typy dokumentów),
 * modal Nowa baza (admin: walidacja namespace live + auto-sugestia z nazwy,
 * typy dokumentów, ostrzeżenie o niezmienności embeddingu, createProject).
 * Kontrakt API: apps/panel-api/src/routes/kbs.ts (+ actions.ts dla 202).
 */

// ── typy odpowiedzi API (services/kb.ts kbToApi) ────────────────────────────

interface DocumentTypeDef {
  name: string;
  description: string;
}

interface KbEntry {
  namespace: string;
  name: string;
  description: string;
  projectId: number | null;
  status: string;
  dirty: boolean;
  schemaVersion: number | null;
  vectorModelId: string;
  documentTypes: DocumentTypeDef[];
  totals: { documents: number; chunks: number; pendingDrafts: number };
  createdAt: string;
  updatedAt: string;
}

interface ActionListItem {
  id: string;
  type: string;
  resource: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

interface BuildJobItem {
  id: number | null;
  name: string;
  status: string;
  statusLabel: string;
  fileUrl: string | null;
  createdAt: string | null;
}

interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

interface LaunchedAction {
  actionId: string;
}

const NS_ERROR_KEY: Record<NamespaceProblem, PlKey> = {
  empty: 'kb.nsError.empty',
  tooShort: 'kb.nsError.tooShort',
  tooLong: 'kb.nsError.tooLong',
  badStart: 'kb.nsError.badStart',
  badChars: 'kb.nsError.badChars',
};

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return t('common.error');
}

// ── strona ──────────────────────────────────────────────────────────────────

export function KbPage() {
  const me = useMe();
  const role = me.data?.user.role;
  const canBuild = can(role, 'kb-build');
  const canCreate = can(role, 'kb-create');

  const kbsQuery = useQuery({
    queryKey: ['kbs'],
    queryFn: () => apiFetch<{ items: KbEntry[] }>('/api/v1/kbs'),
  });
  const kbs = kbsQuery.data?.items ?? [];

  // Ostatni build per baza — z listy akcji build_kb (najnowsze pierwsze).
  const buildActionsQuery = useQuery({
    queryKey: ['actions', { type: 'build_kb' }],
    queryFn: () => apiFetch<{ items: ActionListItem[] }>('/api/v1/actions?type=build_kb&limit=200'),
  });
  const lastBuildByNs = useMemo(() => {
    const map = new Map<string, ActionListItem>();
    for (const action of buildActionsQuery.data?.items ?? []) {
      const ns = action.resource?.startsWith('kb:') === true ? action.resource.slice(3) : null;
      if (ns !== null && !map.has(ns)) map.set(ns, action);
    }
    return map;
  }, [buildActionsQuery.data]);

  const [buildKb, setBuildKb] = useState<KbEntry | null>(null);
  const [detailsNs, setDetailsNs] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [qualityKb, setQualityKb] = useState<{ kb: KbEntry; actionId: string } | null>(null);
  const toast = useToast();

  const quality = useMutation({
    mutationFn: (kb: KbEntry) =>
      apiFetch<Partial<LaunchedAction>>(`/api/v1/kbs/${kb.namespace}/quality`, { method: 'POST' }),
    onSuccess: (data, kb) => {
      if (typeof data.actionId === 'string') {
        toast.show(t('kb.quality.started'), 'ok');
        setQualityKb({ kb, actionId: data.actionId });
      } else {
        toast.show(t('kb.quality.started'), 'ok');
      }
    },
    onError: (err) => toast.show(t('kb.quality.failed', { message: errorMessage(err) }), 'fail'),
  });

  const columns = useMemo(() => {
    const cols: Column<KbEntry>[] = [
      {
        key: 'name',
        header: t('kb.col.name'),
        render: (row) => (
          <div className="stack-tight">
            <strong>{row.name}</strong>
            <code className="muted">{row.namespace}</code>
          </div>
        ),
      },
      {
        key: 'status',
        header: t('kb.col.status'),
        render: (row) => (
          <div className="row">
            <StatusBadge status={row.status} />
            {row.dirty && <span className="chip chip-warn">{t('kb.dirtyChip')}</span>}
          </div>
        ),
      },
      {
        key: 'project',
        header: t('kb.col.project'),
        render: (row) =>
          row.projectId !== null ? <code>#{row.projectId}</code> : <span className="muted">{t('kb.noProject')}</span>,
      },
      {
        key: 'totals',
        header: t('kb.col.totals'),
        render: (row) => (
          <div className="stack-tight">
            <span>
              {t('kb.totals.summary', {
                docs: formatNumber(row.totals.documents),
                chunks: formatNumber(row.totals.chunks),
              })}
            </span>
            {row.totals.pendingDrafts > 0 && (
              <span className="muted">{t('kb.totals.pending', { count: formatNumber(row.totals.pendingDrafts) })}</span>
            )}
          </div>
        ),
      },
      {
        key: 'lastBuild',
        header: t('kb.col.lastBuild'),
        render: (row) => {
          const last = lastBuildByNs.get(row.namespace);
          if (last === undefined) return <span className="muted">{t('kb.noBuildYet')}</span>;
          return (
            <div className="stack-tight">
              <StatusBadge status={last.status} />
              <span className="muted">{formatDateTime(last.finishedAt ?? last.startedAt)}</span>
            </div>
          );
        },
      },
      {
        key: 'gate',
        // Verdict quality gate — raporty pojawią się z akcją quality (Faza 4).
        header: t('kb.col.gate'),
        render: () => <span className="muted">{t('kb.noGateReport')}</span>,
      },
      {
        key: 'actions',
        header: t('kb.col.actions'),
        render: (row) => (
          <div className="row" onClick={(ev) => ev.stopPropagation()}>
            {canBuild && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setBuildKb(row)}>
                {t('kb.action.build')}
              </button>
            )}
            {canBuild && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={quality.isPending}
                onClick={() => quality.mutate(row)}
              >
                {t('kb.action.quality')}
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDetailsNs(row.namespace)}>
              {t('kb.action.details')}
            </button>
          </div>
        ),
      },
    ];
    return cols;
  }, [canBuild, lastBuildByNs, quality.isPending]);

  return (
    <div className="stack">
      <div className="row">
        <h1 className="page-title grow">{t('nav.kb')}</h1>
        {canCreate && (
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            {t('kb.create.button')}
          </button>
        )}
      </div>

      {kbsQuery.isLoading ? (
        <div className="stack">
          <Skeleton height="40px" />
          <Skeleton height="160px" />
        </div>
      ) : kbsQuery.isError ? (
        <div className="card stack">
          <span>{errorMessage(kbsQuery.error)}</span>
          <button type="button" className="btn" onClick={() => void kbsQuery.refetch()}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={kbs}
          rowKey={(row) => row.namespace}
          onRowClick={(row) => setDetailsNs(row.namespace)}
          empty={
            <EmptyState
              icon="📚"
              title={t('kb.empty.title')}
              description={canCreate ? t('kb.empty.description') : t('kb.empty.askAdmin')}
              action={
                canCreate ? (
                  <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                    {t('kb.create.button')}
                  </button>
                ) : undefined
              }
            />
          }
        />
      )}

      <BuildModal kb={buildKb} onClose={() => setBuildKb(null)} />
      <KbDetailsDrawer namespace={detailsNs} onClose={() => setDetailsNs(null)} />
      <CreateKbModal open={createOpen} onClose={() => setCreateOpen(false)} />

      {/* obserwacja akcji quality (gdy backend zwróci 202+actionId) */}
      <Modal
        open={qualityKb !== null}
        onClose={() => setQualityKb(null)}
        title={qualityKb !== null ? t('kb.quality.modalTitle', { name: qualityKb.kb.name }) : ''}
      >
        {qualityKb !== null && (
          <ActionProgress
            actionId={qualityKb.actionId}
            onFinished={() => void queryClient.invalidateQueries({ queryKey: ['kbs'] })}
          />
        )}
      </Modal>
    </div>
  );
}

// ── modal builda: preflight → build → obserwacja akcji ──────────────────────

function BuildModal({ kb, onClose }: { kb: KbEntry | null; onClose: () => void }) {
  const toast = useToast();
  const [actionId, setActionId] = useState<string | null>(null);

  useEffect(() => setActionId(null), [kb?.namespace]);

  // Preflight to dry-run bez mutacji — POST tylko ze względu na CSRF/rate-limit.
  const preflightQuery = useQuery({
    queryKey: ['kb-preflight', kb?.namespace],
    queryFn: () => apiFetch<PreflightResult>(`/api/v1/kbs/${kb?.namespace}/preflight`, { method: 'POST' }),
    enabled: kb !== null,
    staleTime: 0,
    gcTime: 0,
  });

  const build = useMutation({
    mutationFn: (namespace: string) =>
      apiFetch<Partial<LaunchedAction>>(`/api/v1/kbs/${namespace}/build`, { method: 'POST' }),
    onSuccess: (data) => {
      if (typeof data.actionId === 'string') {
        toast.show(t('kb.build.started'), 'ok');
        setActionId(data.actionId);
        void queryClient.invalidateQueries({ queryKey: ['actions'] });
      } else {
        toast.show(t('kb.build.started'), 'ok');
        onClose();
      }
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const groups = preflightQuery.data !== undefined ? groupPreflightChecks(preflightQuery.data.checks) : null;
  const blocked = groups === null || groups.blockers.length > 0;

  const onBuildFinished = (state: ActionState): void => {
    void queryClient.invalidateQueries({ queryKey: ['kbs'] });
    void queryClient.invalidateQueries({ queryKey: ['actions'] });
    toast.show(t('kb.build.finished', { status: statusLabel(state.status) }), state.status === 'success' ? 'ok' : 'fail');
  };

  return (
    <Modal
      open={kb !== null}
      onClose={onClose}
      title={kb !== null ? t('kb.build.modalTitle', { name: kb.name }) : ''}
      wide
      footer={
        actionId === null ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={blocked || build.isPending}
              onClick={() => kb !== null && build.mutate(kb.namespace)}
            >
              {groups !== null && groups.warnings.length > 0 ? t('kb.build.startDespiteWarnings') : t('kb.build.start')}
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        )
      }
    >
      {actionId !== null ? (
        <ActionProgress actionId={actionId} onFinished={onBuildFinished} />
      ) : preflightQuery.isLoading ? (
        <div className="stack">
          <p className="muted">{t('kb.build.preflightRunning')}</p>
          <Skeleton height="80px" />
        </div>
      ) : preflightQuery.isError ? (
        <div className="stack">
          <p>{t('kb.build.preflightError', { message: errorMessage(preflightQuery.error) })}</p>
          <button type="button" className="btn" onClick={() => void preflightQuery.refetch()}>
            {t('common.retry')}
          </button>
        </div>
      ) : groups !== null ? (
        <div className="stack">
          {groups.blockers.length > 0 && <CheckList title={t('kb.build.blockers')} checks={groups.blockers} kind="fail" />}
          {groups.warnings.length > 0 && <CheckList title={t('kb.build.warnings')} checks={groups.warnings} kind="warn" />}
          {groups.passed.length > 0 && <CheckList title={t('kb.build.passed')} checks={groups.passed} kind="ok" />}
        </div>
      ) : null}
    </Modal>
  );
}

function CheckList({ title, checks, kind }: { title: string; checks: PreflightCheck[]; kind: 'ok' | 'warn' | 'fail' }) {
  return (
    <section>
      <h3 className="section-title">{title}</h3>
      <ul className="check-list">
        {checks.map((check) => (
          <li key={check.id} data-kind={kind}>
            <span className="check-icon" aria-hidden="true">
              {kind === 'ok' ? '✓' : kind === 'warn' ? '⚠' : '✕'}
            </span>
            <span>
              <strong>{t(preflightCheckLabelKey(check.id))}</strong>
              <span className="muted"> — {check.message}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── drawer szczegółów bazy ──────────────────────────────────────────────────

function KbDetailsDrawer({ namespace, onClose }: { namespace: string | null; onClose: () => void }) {
  const detailQuery = useQuery({
    queryKey: ['kbs', namespace],
    queryFn: () => apiFetch<{ kb: KbEntry }>(`/api/v1/kbs/${namespace}`),
    enabled: namespace !== null,
  });
  const kb = detailQuery.data?.kb;

  const jobsQuery = useQuery({
    queryKey: ['kbs', namespace, 'jobs'],
    queryFn: () => apiFetch<{ items: BuildJobItem[] }>(`/api/v1/kbs/${namespace}/jobs?limit=50`),
    enabled: namespace !== null && kb !== undefined && kb.projectId !== null,
  });

  return (
    <Drawer open={namespace !== null} onClose={onClose} title={kb?.name ?? (namespace ?? '')}>
      {detailQuery.isLoading && (
        <div className="stack">
          <Skeleton height="18px" width="50%" />
          <Skeleton height="120px" />
        </div>
      )}
      {detailQuery.isError && <p>{errorMessage(detailQuery.error)}</p>}
      {kb !== undefined && (
        <div className="stack">
          <div className="row">
            <StatusBadge status={kb.status} />
            {kb.dirty && <span className="chip chip-warn">{t('kb.dirtyChip')}</span>}
            <code>{kb.namespace}</code>
          </div>

          <dl className="details-list">
            <dt>{t('kb.details.description')}</dt>
            <dd>{kb.description !== '' ? kb.description : <span className="muted">{t('kb.details.noDescription')}</span>}</dd>
            <dt>{t('kb.col.project')}</dt>
            <dd>{kb.projectId !== null ? `#${kb.projectId}` : t('kb.noProject')}</dd>
            <dt>{t('kb.details.schemaVersion')}</dt>
            <dd>{kb.schemaVersion !== null ? `v${kb.schemaVersion}` : '—'}</dd>
            <dt>{t('kb.details.vectorModel')}</dt>
            <dd>
              {kb.vectorModelId !== '' ? (
                <code>{kb.vectorModelId}</code>
              ) : (
                <span className="muted">{t('kb.details.vectorModelMissing')}</span>
              )}
            </dd>
            <dt>{t('kb.col.totals')}</dt>
            <dd>
              {t('kb.totals.summary', {
                docs: formatNumber(kb.totals.documents),
                chunks: formatNumber(kb.totals.chunks),
              })}
            </dd>
          </dl>

          <section>
            <h3 className="section-title">{t('kb.details.documentTypes')}</h3>
            {kb.documentTypes.length === 0 ? (
              <p className="muted">{t('kb.details.noDocumentTypes')}</p>
            ) : (
              <ul className="doc-type-list">
                {kb.documentTypes.map((docType) => (
                  <li key={docType.name}>
                    <strong>{docType.name}</strong>
                    {docType.description !== '' && <span className="muted"> — {docType.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="section-title">{t('kb.details.buildHistory')}</h3>
            {kb.projectId === null ? (
              <p className="muted">{t('kb.details.jobsUnavailable')}</p>
            ) : jobsQuery.isLoading ? (
              <Skeleton height="80px" />
            ) : jobsQuery.isError ? (
              <p className="muted">{errorMessage(jobsQuery.error)}</p>
            ) : (jobsQuery.data?.items.length ?? 0) === 0 ? (
              <p className="muted">{t('kb.details.noJobs')}</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('kb.details.jobCol.name')}</th>
                      <th>{t('kb.details.jobCol.status')}</th>
                      <th>{t('kb.details.jobCol.date')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(jobsQuery.data?.items ?? []).map((job, index) => (
                      <tr key={job.id ?? `${job.name}-${index}`}>
                        <td>{job.name !== '' ? job.name : (job.fileUrl ?? '—')}</td>
                        <td>
                          <StatusBadge status={job.status} label={job.statusLabel} />
                        </td>
                        <td className="muted">{job.createdAt !== null ? formatDateTime(job.createdAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h3 className="section-title">{t('kb.details.gateReport')}</h3>
            <p className="muted">{t('kb.details.noGateReport')}</p>
          </section>
        </div>
      )}
    </Drawer>
  );
}

// ── modal „Nowa baza" (admin) ───────────────────────────────────────────────

interface CreateForm {
  name: string;
  namespace: string;
  nsTouched: boolean;
  description: string;
  documentTypes: DocumentTypeDef[];
  createProject: boolean;
}

const EMPTY_FORM: CreateForm = {
  name: '',
  namespace: '',
  nsTouched: false,
  description: '',
  documentTypes: [{ name: '', description: '' }],
  createProject: true,
};

function CreateKbModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [actionId, setActionId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_FORM, documentTypes: [{ name: '', description: '' }] });
      setActionId(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: (input: CreateForm) =>
      apiFetch<{ kb: KbEntry } & Partial<LaunchedAction>>('/api/v1/kbs', {
        method: 'POST',
        body: {
          namespace: input.namespace,
          name: input.name.trim(),
          description: input.description.trim(),
          documentTypes: input.documentTypes
            .map((docType) => ({ name: docType.name.trim(), description: docType.description.trim() }))
            .filter((docType) => docType.name !== ''),
          createProject: input.createProject,
        },
      }),
    onSuccess: (data, input) => {
      void queryClient.invalidateQueries({ queryKey: ['kbs'] });
      if (typeof data.actionId === 'string') {
        // 202 — provisioning projektu OpenSPG w tle: obserwujemy akcję w modalu.
        setActionId(data.actionId);
      } else {
        toast.show(t('kb.create.created', { name: input.name.trim() }), 'ok');
        onClose();
      }
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const nsProblem = namespaceProblem(form.namespace);
  const canSubmit = form.name.trim() !== '' && isValidNamespace(form.namespace) && !create.isPending;

  const setDocType = (index: number, patch: Partial<DocumentTypeDef>): void => {
    setForm((prev) => ({
      ...prev,
      documentTypes: prev.documentTypes.map((docType, i) => (i === index ? { ...docType, ...patch } : docType)),
    }));
  };

  const onProvisionFinished = (state: ActionState): void => {
    void queryClient.invalidateQueries({ queryKey: ['kbs'] });
    toast.show(
      t('kb.create.provisionFinished', { status: statusLabel(state.status) }),
      state.status === 'success' ? 'ok' : 'fail',
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('kb.create.modalTitle')}
      wide
      footer={
        actionId === null ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="submit" form="create-kb-form" className="btn btn-primary" disabled={!canSubmit}>
              {t('kb.create.submit')}
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        )
      }
    >
      {actionId !== null ? (
        <div className="stack">
          <p className="muted">{t('kb.create.provisioning')}</p>
          <ActionProgress actionId={actionId} onFinished={onProvisionFinished} />
        </div>
      ) : (
        <form
          id="create-kb-form"
          className="stack"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (canSubmit) create.mutate(form);
          }}
        >
          <label className="stack-tight">
            <span className="muted">{t('kb.create.name')}</span>
            <input
              className="input"
              value={form.name}
              required
              placeholder={t('kb.create.namePlaceholder')}
              onChange={(ev) => {
                const name = ev.target.value;
                setForm((prev) => ({
                  ...prev,
                  name,
                  // Auto-sugestia namespace z nazwy, dopóki użytkownik nie edytował pola ręcznie.
                  namespace: prev.nsTouched ? prev.namespace : suggestNamespace(name),
                }));
              }}
            />
          </label>

          <label className="stack-tight">
            <span className="muted">{t('kb.create.namespace')}</span>
            <input
              className="input"
              value={form.namespace}
              required
              spellCheck={false}
              onChange={(ev) => setForm((prev) => ({ ...prev, namespace: ev.target.value, nsTouched: true }))}
            />
            {nsProblem !== null ? (
              <span className="field-error">{t(NS_ERROR_KEY[nsProblem])}</span>
            ) : (
              <span className="field-ok">{t('kb.nsOk')}</span>
            )}
            <span className="muted field-hint">{t('kb.create.namespaceHint')}</span>
          </label>

          <label className="stack-tight">
            <span className="muted">{t('kb.create.description')}</span>
            <textarea
              className="input"
              rows={2}
              value={form.description}
              onChange={(ev) => setForm((prev) => ({ ...prev, description: ev.target.value }))}
            />
          </label>

          <section className="stack-tight">
            <span className="muted">{t('kb.create.documentTypes')}</span>
            <span className="muted field-hint">{t('kb.create.documentTypesHint')}</span>
            {form.documentTypes.map((docType, index) => (
              // Fundament Kreatora KB: dynamiczna lista typów dokumentów (nazwa+opis).
              <div key={index} className="doc-type-row">
                <input
                  className="input"
                  value={docType.name}
                  placeholder={t('kb.create.docTypeName')}
                  aria-label={t('kb.create.docTypeName')}
                  onChange={(ev) => setDocType(index, { name: ev.target.value })}
                />
                <input
                  className="input grow"
                  value={docType.description}
                  placeholder={t('kb.create.docTypeDescription')}
                  aria-label={t('kb.create.docTypeDescription')}
                  onChange={(ev) => setDocType(index, { description: ev.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('kb.create.removeDocType')}
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      documentTypes: prev.documentTypes.filter((_, i) => i !== index),
                    }))
                  }
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={form.documentTypes.length >= 20}
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    documentTypes: [...prev.documentTypes, { name: '', description: '' }],
                  }))
                }
              >
                {t('kb.create.addDocType')}
              </button>
            </div>
          </section>

          <div className="warning-box">{t('kb.create.embeddingWarning')}</div>

          <label className="row">
            <input
              type="checkbox"
              checked={form.createProject}
              onChange={(ev) => setForm((prev) => ({ ...prev, createProject: ev.target.checked }))}
            />
            <span>{t('kb.create.createProject')}</span>
          </label>
        </form>
      )}
    </Modal>
  );
}
