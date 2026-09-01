/**
 * /add „Dodaj treść" — taby Tekst | Plik (drag&drop), wybór KB (opcjonalny —
 * analiza może nadpisać), POST /api/v1/content (202 {intakeId}), polling
 * GET /api/v1/content/:id co 2 s → Stepper LUDZKICH etapów (pole stages/humanized
 * z backendu — apps/panel-api/src/routes/content.ts, zweryfikowane), lista
 * ostatnich intake'ów. Prefill ?question= z luki wiedzy (nagłówek „Uzupełniasz
 * lukę: …"). URL to WYŁĄCZNIE metadana źródła (v1 bez fetchu — decyzja z soczewek).
 */
import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { apiFetch, ApiError } from '../lib/api';
import {
  isIntakeTerminal,
  stagesToSteps,
  UPLOAD_ACCEPT,
  UPLOAD_EXTENSIONS,
  validateUploadFile,
  type IntakeStageApi,
} from '../lib/intake';
import { can } from '../lib/permissions';
import { useMe } from '../hooks/useMe';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { StatusBadge } from '../components/StatusBadge';
import { Stepper } from '../components/Stepper';
import { useToast } from '../components/Toast';
import { t, formatDateTime } from '../i18n/t';

// ── Kontrakty API (content.ts + kbs.ts — realne trasy panel-api) ─────────────

interface KbItem {
  namespace: string;
  name: string;
  status: string;
  isDefault: boolean;
}

interface HumanMessage {
  label: string;
  description?: string;
  action?: string;
}

interface IntakeDetail {
  id: string;
  sourceKind: string;
  originalName: string | null;
  sourceUrl: string | null;
  status: string;
  statusHuman: HumanMessage;
  draftId: string | null;
  error: string | null;
  errorHuman: HumanMessage | null;
  stages: IntakeStageApi[];
  createdAt: string;
  updatedAt: string;
}

interface IntakeListItem {
  id: string;
  sourceKind: string;
  originalName: string | null;
  status: string;
  statusHuman: HumanMessage;
  draftId: string | null;
  error: string | null;
  createdAt: string;
}

interface SubmitResponse {
  intakeId: string;
  status: string;
  deduplicated?: boolean;
}

const EXT_LIST = UPLOAD_EXTENSIONS.join(', ');

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// ── Stepper przetwarzania aktywnego intake'u (polling co 2 s) ────────────────

interface IntakeProgressProps {
  intakeId: string;
  deduplicated: boolean;
  canInbox: boolean;
  onReset: () => void;
}

function IntakeProgress({ intakeId, deduplicated, canInbox, onReset }: IntakeProgressProps) {
  const query = useQuery({
    queryKey: ['content', intakeId],
    queryFn: () => apiFetch<{ intake: IntakeDetail }>(`/api/v1/content/${encodeURIComponent(intakeId)}`),
    refetchInterval: (q) => (isIntakeTerminal(q.state.data?.intake.status) ? false : 2000),
  });

  const intake = query.data?.intake;
  return (
    <section className="card stack" aria-live="polite">
      <h2 className="add-section-title">{t('add.progress.title')}</h2>
      {deduplicated && <p className="muted">{t('add.dedup')}</p>}
      {intake === undefined ? (
        <div className="stack">
          <Skeleton height="18px" />
          <Skeleton height="18px" width="60%" />
        </div>
      ) : (
        <>
          <Stepper steps={stagesToSteps(intake.stages, intake.status)} />
          {intake.status === 'failed' && (
            <div className="card add-failed stack">
              <strong>{t('add.failed.title')}</strong>
              <div>{intake.errorHuman?.label ?? intake.statusHuman.label}</div>
              {intake.errorHuman?.description !== undefined && (
                <p className="muted">{intake.errorHuman.description}</p>
              )}
              {/* Akcja naprawcza ze słownika komunikatów (soczewka product). */}
              {intake.errorHuman?.action !== undefined && <p>💡 {intake.errorHuman.action}</p>}
              <div className="row">
                <button type="button" className="btn" onClick={onReset}>
                  {t('common.retry')}
                </button>
              </div>
            </div>
          )}
          {intake.status === 'drafted' && (
            <div className="card add-done stack">
              <strong>✓ {t('add.done.title')}</strong>
              <p className="muted">{t('add.done.description')}</p>
              <div className="row">
                {canInbox && (
                  <Link to="/inbox" search={{ status: 'pending' }} className="btn btn-primary btn-sm">
                    {t('add.done.inboxLink')}
                  </Link>
                )}
                <button type="button" className="btn btn-sm" onClick={onReset}>
                  {t('add.done.again')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Lista ostatnich intake'ów (GET /api/v1/content) ──────────────────────────

function RecentIntakes() {
  const query = useQuery({
    queryKey: ['content-list'],
    queryFn: () => apiFetch<{ items: IntakeListItem[] }>('/api/v1/content'),
    staleTime: 10_000,
  });

  return (
    <section className="stack">
      <h2 className="add-section-title">{t('add.recent.title')}</h2>
      {query.isLoading && (
        <div className="stack">
          <Skeleton height="18px" />
          <Skeleton height="18px" width="70%" />
        </div>
      )}
      {query.isError && <p className="muted">{t('common.error')}</p>}
      {query.data !== undefined &&
        (query.data.items.length === 0 ? (
          <EmptyState
            icon="📄"
            title={t('add.recent.empty.title')}
            description={t('add.recent.empty.description')}
          />
        ) : (
          <ul className="add-recent-list">
            {query.data.items.map((item) => (
              <li key={item.id} className="add-recent-item">
                <span className="add-recent-name grow">{item.originalName ?? t('add.recent.untitled')}</span>
                <StatusBadge status={item.status} label={item.statusHuman.label} />
                <span className="muted add-recent-date">{formatDateTime(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

// ── Strona ───────────────────────────────────────────────────────────────────

type AddTab = 'text' | 'file';

export function AddPage() {
  const me = useMe();
  const toast = useToast();
  const queryClient = useQueryClient();
  const search = useSearch({ from: '/add' });
  const gapQuestion = search.question;

  const [tab, setTab] = useState<AddTab>('text');
  const [text, setText] = useState('');
  const [title, setTitle] = useState(gapQuestion ?? '');
  const [sourceUrl, setSourceUrl] = useState('');
  const [namespace, setNamespace] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [active, setActive] = useState<{ intakeId: string; deduplicated: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const kbsQuery = useQuery({
    queryKey: ['kbs'],
    queryFn: () => apiFetch<{ items: KbItem[] }>('/api/v1/kbs'),
    staleTime: 60_000,
  });
  const activeKbs = (kbsQuery.data?.items ?? []).filter((kb) => kb.status === 'active');
  const defaultKb = activeKbs.find((kb) => kb.isDefault);

  const submitMutation = useMutation({
    mutationFn: async (): Promise<SubmitResponse> => {
      if (tab === 'file') {
        if (file === null) throw new ApiError('validation_error', t('add.file.required'), 0);
        const form = new FormData();
        form.append('file', file);
        // KB jako pole multipart — dziś ignorowane przez backend (analyze
        // routuje sam), forward-compatible gdy content.ts zacznie je czytać.
        const chosen = namespace !== '' ? namespace : defaultKb?.namespace;
        if (chosen !== undefined) form.append('namespace', chosen);
        return apiFetch<SubmitResponse>('/api/v1/content', { method: 'POST', body: form });
      }
      if (text.trim() === '') throw new ApiError('validation_error', t('add.text.required'), 0);
      // Kontrakt content.ts (zweryfikowany): JSON przyjmuje TYLKO {text,title?,sourceUrl?}
      // (additionalProperties → validation_error) — wybranej KB nie wysyłamy; routing robi analyze.
      const body: { text: string; title?: string; sourceUrl?: string } = { text: text.trim() };
      if (title.trim() !== '') body.title = title.trim();
      if (sourceUrl.trim() !== '') body.sourceUrl = sourceUrl.trim();
      return apiFetch<SubmitResponse>('/api/v1/content', { method: 'POST', body });
    },
    onSuccess: (data) => {
      setActive({ intakeId: data.intakeId, deduplicated: data.deduplicated === true });
      void queryClient.invalidateQueries({ queryKey: ['content-list'] });
    },
    onError: (err) => {
      toast.show(err instanceof ApiError ? err.message : t('common.error'), 'fail');
    },
  });

  function acceptFile(candidate: File): void {
    const verdict = validateUploadFile(candidate.name, candidate.size);
    if (!verdict.ok) {
      toast.show(
        verdict.code === 'size' ? t('add.file.tooLarge') : t('add.file.badExtension', { list: EXT_LIST }),
        'warn',
      );
      return;
    }
    setFile(candidate);
  }

  function onDrop(ev: DragEvent<HTMLDivElement>): void {
    ev.preventDefault();
    setDragOver(false);
    const dropped = ev.dataTransfer.files[0];
    if (dropped !== undefined) acceptFile(dropped);
  }

  function onSubmit(ev: FormEvent): void {
    ev.preventDefault();
    if (submitMutation.isPending) return;
    if (tab === 'text' && text.trim() === '') {
      toast.show(t('add.text.required'), 'warn');
      return;
    }
    if (tab === 'file' && file === null) {
      toast.show(t('add.file.required'), 'warn');
      return;
    }
    submitMutation.mutate();
  }

  function resetForm(): void {
    setActive(null);
    setText('');
    setTitle('');
    setSourceUrl('');
    setFile(null);
    submitMutation.reset();
  }

  const canInbox = can(me.data?.user.role, 'inbox');

  return (
    <div className="add-page stack">
      <header className="stack add-header">
        <h1 className="add-title">{t('add.pageTitle')}</h1>
        <p className="muted">{t('add.pageDescription')}</p>
        {gapQuestion !== undefined && (
          <div className="card add-gap-banner">🧩 {t('add.gapHeader', { question: gapQuestion })}</div>
        )}
      </header>

      <form className="card stack" onSubmit={onSubmit}>
        <div className="add-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'text'}
            className={tab === 'text' ? 'add-tab add-tab-active' : 'add-tab'}
            onClick={() => setTab('text')}
          >
            {t('add.tab.text')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'file'}
            className={tab === 'file' ? 'add-tab add-tab-active' : 'add-tab'}
            onClick={() => setTab('file')}
          >
            {t('add.tab.file')}
          </button>
        </div>

        {tab === 'text' ? (
          <div className="stack">
            <label className="stack add-field">
              <span>{t('add.text.label')}</span>
              <textarea
                className="input"
                rows={8}
                value={text}
                placeholder={t('add.text.placeholder')}
                onChange={(ev) => setText(ev.target.value)}
              />
            </label>
            <label className="stack add-field">
              <span>{t('add.titleField.label')}</span>
              <input className="input" value={title} onChange={(ev) => setTitle(ev.target.value)} />
            </label>
            <label className="stack add-field">
              <span>{t('add.sourceUrl.label')}</span>
              <input
                className="input"
                type="url"
                value={sourceUrl}
                placeholder="https://…"
                onChange={(ev) => setSourceUrl(ev.target.value)}
              />
              <span className="muted add-hint">{t('add.sourceUrl.hint')}</span>
            </label>
          </div>
        ) : (
          <div
            className={dragOver ? 'add-dropzone add-dropzone-over' : 'add-dropzone'}
            onDragOver={(ev) => {
              ev.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            {file === null ? (
              <div className="stack add-dropzone-inner">
                <span aria-hidden="true" className="add-dropzone-icon">
                  📎
                </span>
                <span>{t('add.file.dropHere')}</span>
                <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
                  {t('add.file.pick')}
                </button>
                <span className="muted add-hint">{t('add.file.accepted', { list: EXT_LIST })}</span>
              </div>
            ) : (
              <div className="stack add-dropzone-inner">
                <span>{t('add.file.selected', { name: file.name, size: formatSize(file.size) })}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFile(null)}>
                  {t('add.file.clear')}
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={UPLOAD_ACCEPT}
              className="visually-hidden"
              onChange={(ev) => {
                const picked = ev.target.files?.[0];
                if (picked !== undefined) acceptFile(picked);
                ev.target.value = '';
              }}
            />
          </div>
        )}

        <label className="stack add-field">
          <span>{t('add.kb.label')}</span>
          <select className="input" value={namespace} onChange={(ev) => setNamespace(ev.target.value)}>
            <option value="">{t('add.kb.auto')}</option>
            {activeKbs.map((kb) => (
              <option key={kb.namespace} value={kb.namespace}>
                {kb.name} ({kb.namespace}){kb.isDefault ? ' ★' : ''}
              </option>
            ))}
          </select>
          <span className="muted add-hint">{t('add.kb.hint')}</span>
        </label>

        <div className="row">
          <span className="grow" />
          <button type="submit" className="btn btn-primary" disabled={submitMutation.isPending}>
            {submitMutation.isPending ? t('add.submitting') : t('add.submit')}
          </button>
        </div>
      </form>

      {active !== null && (
        <IntakeProgress
          intakeId={active.intakeId}
          deduplicated={active.deduplicated}
          canInbox={canInbox}
          onReset={resetForm}
        />
      )}

      <RecentIntakes />
    </div>
  );
}
