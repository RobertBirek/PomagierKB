import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { apiFetch, ApiError } from '../lib/api';
import { keyBadgeInfo, validateProfileForm, MCP_TOOLS, type ProfileFormErrorField } from '../lib/mcp';
import { useMe } from '../hooks/useMe';
import { useStatus } from '../hooks/useStatus';
import { t, formatDateTime, type PlKey } from '../i18n/t';
import { DataTable, type Column } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { ConfirmButton } from '../components/ConfirmButton';
import { CopyField } from '../components/CopyField';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import type { McpTab } from '../router';

/**
 * Strona /mcp (admin): klucze API (raw pokazywany DOKŁADNIE raz), profile MCP,
 * snippety konfiguracyjne, konta serwisowe (disable z kaskadą) i health serwera.
 * Kontrakt: apps/panel-api/src/routes/{mcp-admin,users}.ts.
 */

// ── Kształty API (lustro services/mcp-admin.ts + routes/users.ts) ────────────

interface ApiKeyView {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  scopes: string[];
  profileId: string;
  status: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  lastUsedAt: string | null;
  requestsCount: number;
  revokedAt: string | null;
}

interface McpProfileView {
  id: string;
  name: string;
  description: string | null;
  namespaces: string[] | null;
  tools: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface McpSnippetsView {
  profileId: string;
  url: string;
  snippets: { claudeCode: string; cursor: string; generic: string };
}

interface McpHealthView {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  detail: string;
}

interface UserView {
  id: string;
  sub: string | null;
  email: string | null;
  displayName: string;
  kind: 'oidc' | 'service';
  role: 'viewer' | 'operator' | 'admin';
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

interface KbListView {
  items: { namespace: string; name: string; status: string }[];
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

// ── Współdzielone hooki danych ───────────────────────────────────────────────

function useKeys() {
  return useQuery({ queryKey: ['mcp', 'keys'], queryFn: () => apiFetch<ApiKeyView[]>('/api/v1/mcp/keys') });
}

function useProfiles() {
  return useQuery({
    queryKey: ['mcp', 'profiles'],
    queryFn: () => apiFetch<McpProfileView[]>('/api/v1/mcp/profiles'),
  });
}

function useUsers(enabled: boolean) {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => apiFetch<{ users: UserView[] }>('/api/v1/users'),
    enabled,
  });
}

function useKbs() {
  return useQuery({ queryKey: ['kbs'], queryFn: () => apiFetch<KbListView>('/api/v1/kbs') });
}

// ── Blok kodu z kopiowaniem (snippety wieloliniowe) ──────────────────────────

function CodeBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* brak uprawnień clipboard — użytkownik zaznaczy ręcznie */
    }
  }
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row">
        <strong>{label}</strong>
        <span className="grow" />
        <button type="button" className="btn btn-sm" onClick={() => void copy()}>
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <pre className="code-block">{value}</pre>
    </div>
  );
}

// ── Modal wyniku: raw klucz pokazywany DOKŁADNIE RAZ ─────────────────────────

function RawKeyModal({ raw, onClose }: { raw: string | null; onClose: () => void }) {
  return (
    <Modal open={raw !== null} onClose={onClose} title={t('mcp.raw.title')}>
      <p className="callout callout-warn">{t('mcp.raw.warning')}</p>
      {raw !== null && <CopyField value={raw} label={t('mcp.raw.keyLabel')} />}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t('mcp.raw.done')}
        </button>
      </div>
    </Modal>
  );
}

// ── Zakładka: Klucze API ─────────────────────────────────────────────────────

interface CreateKeyBody {
  label: string;
  profileId: string;
  scopes: string[];
  ttlDays: number;
  userId?: string;
}

function CreateKeyModal({
  open,
  onClose,
  isAdmin,
  profiles,
  serviceUsers,
  onRaw,
}: {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  profiles: McpProfileView[];
  serviceUsers: UserView[];
  onRaw: (raw: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [profileId, setProfileId] = useState('');
  const [identity, setIdentity] = useState<'me' | 'service' | 'new'>('me');
  const [serviceId, setServiceId] = useState('');
  const [newServiceName, setNewServiceName] = useState('');
  const [write, setWrite] = useState(false);
  const [ttlDays, setTtlDays] = useState(90);
  const [formError, setFormError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      let userId: string | undefined;
      if (identity === 'service') userId = serviceId;
      if (identity === 'new') {
        const created = await apiFetch<{ user: UserView }>('/api/v1/users', {
          method: 'POST',
          body: { kind: 'service', displayName: newServiceName.trim() },
        });
        userId = created.user.id;
      }
      const body: CreateKeyBody = {
        label: label.trim(),
        profileId,
        scopes: write ? ['read', 'write'] : ['read'],
        ttlDays,
      };
      if (userId !== undefined) body.userId = userId;
      return apiFetch<{ key: ApiKeyView; raw: string }>('/api/v1/mcp/keys', { method: 'POST', body });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['mcp', 'keys'] });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.show(t('mcp.toast.keyCreated'), 'ok');
      onClose();
      onRaw(data.raw);
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  function submit(): void {
    const missing =
      label.trim() === '' ||
      profileId === '' ||
      (identity === 'service' && serviceId === '') ||
      (identity === 'new' && newServiceName.trim() === '') ||
      ttlDays < 1 ||
      ttlDays > 365;
    if (missing) {
      setFormError(t('mcp.create.validation'));
      return;
    }
    setFormError(null);
    create.mutate();
  }

  const activeServiceUsers = serviceUsers.filter((u) => u.status === 'active');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('mcp.create.title')}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={submit}>
            {t('mcp.create.submit')}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t('mcp.keys.label')}</span>
        <input
          className="input"
          value={label}
          maxLength={200}
          placeholder={t('mcp.create.labelPlaceholder')}
          onChange={(ev) => setLabel(ev.target.value)}
        />
      </label>

      <label className="field">
        <span>{t('mcp.keys.profile')}</span>
        <select className="input" value={profileId} onChange={(ev) => setProfileId(ev.target.value)}>
          <option value="">—</option>
          {profiles
            .filter((p) => p.enabled)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
        </select>
      </label>

      {isAdmin && (
        <fieldset className="field-group">
          <legend>{t('mcp.create.identity')}</legend>
          <label className="row">
            <input type="radio" name="identity" checked={identity === 'me'} onChange={() => setIdentity('me')} />
            <span>{t('mcp.create.identityMe')}</span>
          </label>
          <label className="row">
            <input
              type="radio"
              name="identity"
              checked={identity === 'service'}
              onChange={() => setIdentity('service')}
              disabled={activeServiceUsers.length === 0}
            />
            <span>{t('mcp.create.identityService')}</span>
          </label>
          {identity === 'service' && (
            <select className="input" value={serviceId} onChange={(ev) => setServiceId(ev.target.value)}>
              <option value="">—</option>
              {activeServiceUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
          )}
          <label className="row">
            <input type="radio" name="identity" checked={identity === 'new'} onChange={() => setIdentity('new')} />
            <span>{t('mcp.create.identityNew')}</span>
          </label>
          {identity === 'new' && (
            <label className="field">
              <span>{t('mcp.create.serviceName')}</span>
              <input
                className="input"
                value={newServiceName}
                maxLength={120}
                placeholder={t('mcp.create.serviceNamePlaceholder')}
                onChange={(ev) => setNewServiceName(ev.target.value)}
              />
            </label>
          )}
        </fieldset>
      )}

      <fieldset className="field-group">
        <legend>{t('mcp.create.scope')}</legend>
        <label className="row">
          <input type="checkbox" checked readOnly disabled />
          <span>{t('mcp.create.scopeRead')}</span>
        </label>
        {isAdmin && (
          <label className="row">
            <input type="checkbox" checked={write} onChange={(ev) => setWrite(ev.target.checked)} />
            <span>{t('mcp.create.scopeWrite')}</span>
          </label>
        )}
      </fieldset>

      <label className="field">
        <span>{t('mcp.create.ttl')}</span>
        <input
          className="input"
          type="number"
          min={1}
          max={365}
          value={ttlDays}
          onChange={(ev) => setTtlDays(Number(ev.target.value))}
        />
      </label>

      {formError !== null && <p className="callout callout-fail">{formError}</p>}
    </Modal>
  );
}

function KeysTab({ isAdmin }: { isAdmin: boolean }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const toast = useToast();
  const keys = useKeys();
  const profiles = useProfiles();
  const users = useUsers(isAdmin);
  const [createOpen, setCreateOpen] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);

  const usersById = useMemo(() => {
    const map = new Map<string, UserView>();
    for (const u of users.data?.users ?? []) map.set(u.id, u);
    return map;
  }, [users.data]);

  const rotate = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ key: ApiKeyView; raw: string }>(`/api/v1/mcp/keys/${id}/rotate`, { method: 'POST' }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['mcp', 'keys'] });
      toast.show(t('mcp.toast.keyRotated'), 'ok');
      setRaw(data.raw);
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ key: ApiKeyView }>(`/api/v1/mcp/keys/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mcp', 'keys'] });
      toast.show(t('mcp.toast.keyRevoked'), 'ok');
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  function ownerName(userId: string): string {
    if (userId === me.data?.user.id) return me.data.user.displayName;
    return usersById.get(userId)?.displayName ?? userId;
  }

  const nowMs = Date.now();
  const columns: readonly Column<ApiKeyView>[] = [
    { key: 'label', header: t('mcp.keys.label'), render: (k) => k.label },
    { key: 'prefix', header: t('mcp.keys.prefix'), render: (k) => <code>{k.prefix}…</code> },
    { key: 'owner', header: t('mcp.keys.owner'), render: (k) => ownerName(k.userId) },
    { key: 'profile', header: t('mcp.keys.profile'), render: (k) => k.profileId },
    { key: 'scope', header: t('mcp.keys.scope'), render: (k) => k.scopes.join(', ') },
    {
      key: 'expires',
      header: t('mcp.keys.expires'),
      render: (k) => {
        const info = keyBadgeInfo(k.status, k.expiresAt, nowMs);
        return (
          <span>
            {formatDateTime(k.expiresAt)}
            {info.days !== null && info.days > 0 && (
              <span className="muted"> ({t('mcp.keys.daysLeft', { days: info.days })})</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'lastUsed',
      header: t('mcp.keys.lastUsed'),
      render: (k) => (k.lastUsedAt !== null ? formatDateTime(k.lastUsedAt) : t('mcp.keys.never')),
    },
    {
      key: 'status',
      header: t('mcp.keys.status'),
      render: (k) => {
        const info = keyBadgeInfo(k.status, k.expiresAt, nowMs);
        return <StatusBadge variant={info.variant} label={t(info.labelKey)} />;
      },
    },
    {
      key: 'actions',
      header: t('mcp.keys.actions'),
      render: (k) =>
        k.status === 'active' ? (
          <span className="row" style={{ gap: 6 }}>
            <ConfirmButton className="btn btn-sm" onConfirm={() => rotate.mutate(k.id)}>
              {t('mcp.keys.rotate')}
            </ConfirmButton>
            <ConfirmButton className="btn btn-danger btn-sm" onConfirm={() => revoke.mutate(k.id)}>
              {t('mcp.keys.revoke')}
            </ConfirmButton>
          </span>
        ) : null,
    },
  ];

  if (keys.isPending) return <Skeleton height="180px" />;
  if (keys.isError) {
    return (
      <EmptyState
        icon="⚠️"
        title={t('common.error')}
        description={errMsg(keys.error)}
        action={
          <button type="button" className="btn btn-primary" onClick={() => void keys.refetch()}>
            {t('common.retry')}
          </button>
        }
      />
    );
  }

  const createButton = (
    <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
      {t('mcp.keys.create')}
    </button>
  );

  return (
    <div className="stack">
      <div className="row">
        <span className="grow" />
        {createButton}
      </div>
      <DataTable
        columns={columns}
        rows={keys.data}
        rowKey={(k) => k.id}
        empty={
          <EmptyState
            icon="🔑"
            title={t('mcp.keys.empty.title')}
            description={t('mcp.keys.empty.description')}
            action={createButton}
          />
        }
      />
      <CreateKeyModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        isAdmin={isAdmin}
        profiles={profiles.data ?? []}
        serviceUsers={(users.data?.users ?? []).filter((u) => u.kind === 'service')}
        onRaw={setRaw}
      />
      <RawKeyModal raw={raw} onClose={() => setRaw(null)} />
    </div>
  );
}

// ── Zakładka: Profile ────────────────────────────────────────────────────────

const PROFILE_ERROR_KEY: Record<ProfileFormErrorField, PlKey> = {
  id: 'mcp.profiles.err.id',
  name: 'mcp.profiles.err.name',
  tools: 'mcp.profiles.err.tools',
  namespaces: 'mcp.profiles.err.namespaces',
};

function ProfileFormModal({
  open,
  onClose,
  editing,
  namespaces,
}: {
  open: boolean;
  onClose: () => void;
  /** null = tworzenie nowego profilu. */
  editing: McpProfileView | null;
  namespaces: string[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [id, setId] = useState(editing?.id ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [tools, setTools] = useState<string[]>(editing?.tools ?? ['kb_search', 'kb_answer', 'kb_list']);
  const [allNamespaces, setAllNamespaces] = useState(editing === null || editing.namespaces === null);
  const [picked, setPicked] = useState<string[]>(editing?.namespaces ?? []);
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [errors, setErrors] = useState<ProfileFormErrorField[]>([]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        namespaces: allNamespaces ? null : picked,
        tools,
        enabled,
      };
      return editing === null
        ? apiFetch<McpProfileView>('/api/v1/mcp/profiles', { method: 'POST', body: { id, ...body } })
        : apiFetch<McpProfileView>(`/api/v1/mcp/profiles/${editing.id}`, { method: 'PATCH', body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mcp', 'profiles'] });
      toast.show(t('mcp.toast.profileSaved'), 'ok');
      onClose();
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  function toggle(list: string[], item: string): string[] {
    return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
  }

  function submit(): void {
    const result = validateProfileForm({ id, name, tools, allNamespaces, namespaces: picked }, namespaces);
    setErrors(result.errors);
    if (result.ok) save.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing === null ? t('mcp.profiles.create') : t('mcp.profiles.editTitle')}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t('mcp.profiles.id')}</span>
        <input
          className="input"
          value={id}
          disabled={editing !== null}
          maxLength={64}
          onChange={(ev) => setId(ev.target.value)}
        />
        <span className="muted">{t('mcp.profiles.idHint')}</span>
      </label>
      <label className="field">
        <span>{t('mcp.profiles.name')}</span>
        <input className="input" value={name} maxLength={200} onChange={(ev) => setName(ev.target.value)} />
      </label>
      <label className="field">
        <span>{t('mcp.profiles.description')}</span>
        <textarea
          className="input"
          rows={2}
          value={description}
          maxLength={2000}
          onChange={(ev) => setDescription(ev.target.value)}
        />
      </label>

      <fieldset className="field-group">
        <legend>{t('mcp.profiles.tools')}</legend>
        {MCP_TOOLS.map((tool) => (
          <label key={tool} className="row">
            <input
              type="checkbox"
              checked={tools.includes(tool)}
              onChange={() => setTools((prev) => toggle(prev, tool))}
            />
            <code>{tool}</code>
          </label>
        ))}
      </fieldset>

      <fieldset className="field-group">
        <legend>{t('mcp.profiles.namespaces')}</legend>
        <label className="row">
          <input type="radio" name="ns-mode" checked={allNamespaces} onChange={() => setAllNamespaces(true)} />
          <span>{t('mcp.profiles.namespacesAll')}</span>
        </label>
        <label className="row">
          <input type="radio" name="ns-mode" checked={!allNamespaces} onChange={() => setAllNamespaces(false)} />
          <span>{t('mcp.profiles.namespacesPick')}</span>
        </label>
        {!allNamespaces &&
          namespaces.map((ns) => (
            <label key={ns} className="row" style={{ paddingLeft: 24 }}>
              <input
                type="checkbox"
                checked={picked.includes(ns)}
                onChange={() => setPicked((prev) => toggle(prev, ns))}
              />
              <code>{ns}</code>
            </label>
          ))}
      </fieldset>

      {editing !== null && (
        <label className="row">
          <input type="checkbox" checked={enabled} onChange={(ev) => setEnabled(ev.target.checked)} />
          <span>{t('mcp.profiles.enabledField')}</span>
        </label>
      )}

      {errors.length > 0 && (
        <div className="callout callout-fail">
          {errors.map((field) => (
            <div key={field}>{t(PROFILE_ERROR_KEY[field])}</div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function ProfilesTab({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const profiles = useProfiles();
  const kbs = useKbs();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<McpProfileView | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch<{ deleted: boolean }>(`/api/v1/mcp/profiles/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mcp', 'profiles'] });
      toast.show(t('mcp.toast.profileDeleted'), 'ok');
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  const namespaces = (kbs.data?.items ?? []).map((kb) => kb.namespace);

  const columns: readonly Column<McpProfileView>[] = [
    { key: 'id', header: t('mcp.profiles.id'), render: (p) => <code>{p.id}</code> },
    { key: 'name', header: t('mcp.profiles.name'), render: (p) => p.name },
    {
      key: 'namespaces',
      header: t('mcp.profiles.namespaces'),
      render: (p) => (p.namespaces === null ? t('mcp.profiles.allNamespaces') : p.namespaces.join(', ')),
    },
    {
      key: 'tools',
      header: t('mcp.profiles.tools'),
      render: (p) => <span className="muted">{p.tools.join(', ')}</span>,
    },
    {
      key: 'enabled',
      header: t('mcp.keys.status'),
      render: (p) => <StatusBadge status={p.enabled ? 'active' : 'down'} />,
    },
    ...(isAdmin
      ? ([
          {
            key: 'actions',
            header: t('mcp.keys.actions'),
            render: (p: McpProfileView) => (
              <span className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setEditing(p);
                    setFormOpen(true);
                  }}
                >
                  {t('mcp.profiles.edit')}
                </button>
                <ConfirmButton className="btn btn-danger btn-sm" onConfirm={() => remove.mutate(p.id)}>
                  {t('mcp.profiles.delete')}
                </ConfirmButton>
              </span>
            ),
          },
        ] satisfies Column<McpProfileView>[])
      : []),
  ];

  if (profiles.isPending) return <Skeleton height="180px" />;
  if (profiles.isError) {
    return <EmptyState icon="⚠️" title={t('common.error')} description={errMsg(profiles.error)} />;
  }

  const createButton = isAdmin ? (
    <button
      type="button"
      className="btn btn-primary"
      onClick={() => {
        setEditing(null);
        setFormOpen(true);
      }}
    >
      {t('mcp.profiles.create')}
    </button>
  ) : undefined;

  return (
    <div className="stack">
      {createButton !== undefined && (
        <div className="row">
          <span className="grow" />
          {createButton}
        </div>
      )}
      <DataTable
        columns={columns}
        rows={profiles.data}
        rowKey={(p) => p.id}
        empty={
          <EmptyState
            icon="🧩"
            title={t('mcp.profiles.empty.title')}
            description={t('mcp.profiles.empty.description')}
            {...(createButton !== undefined ? { action: createButton } : {})}
          />
        }
      />
      {formOpen && (
        <ProfileFormModal
          key={editing?.id ?? '∅new'}
          open={formOpen}
          onClose={() => setFormOpen(false)}
          editing={editing}
          namespaces={namespaces}
        />
      )}
    </div>
  );
}

// ── Zakładka: Snippety połączeń ──────────────────────────────────────────────

function SnippetsTab() {
  const profiles = useProfiles();
  const [profileId, setProfileId] = useState('');
  const enabledProfiles = (profiles.data ?? []).filter((p) => p.enabled);
  const effectiveId = profileId !== '' ? profileId : (enabledProfiles[0]?.id ?? '');

  const snippets = useQuery({
    queryKey: ['mcp', 'snippets', effectiveId],
    queryFn: () => apiFetch<McpSnippetsView>(`/api/v1/mcp/snippets?profileId=${encodeURIComponent(effectiveId)}`),
    enabled: effectiveId !== '',
  });

  if (profiles.isPending) return <Skeleton height="180px" />;
  if (enabledProfiles.length === 0) {
    return (
      <EmptyState
        icon="🧩"
        title={t('mcp.profiles.empty.title')}
        description={t('mcp.profiles.empty.description')}
      />
    );
  }

  return (
    <div className="stack">
      <label className="field" style={{ maxWidth: 360 }}>
        <span>{t('mcp.snippets.pickProfile')}</span>
        <select className="input" value={effectiveId} onChange={(ev) => setProfileId(ev.target.value)}>
          {enabledProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.id})
            </option>
          ))}
        </select>
      </label>
      {snippets.isPending && <Skeleton height="120px" />}
      {snippets.isError && <p className="callout callout-fail">{errMsg(snippets.error)}</p>}
      {snippets.data !== undefined && (
        <div className="stack">
          <p className="muted">{t('mcp.snippets.hint', { placeholder: '<TWÓJ_KLUCZ>' })}</p>
          <div className="stack" style={{ gap: 4 }}>
            <strong>{t('mcp.snippets.url')}</strong>
            <CopyField value={snippets.data.url} label={t('mcp.snippets.url')} />
          </div>
          <CodeBlock label={t('mcp.snippets.claudeCode')} value={snippets.data.snippets.claudeCode} />
          <CodeBlock label={t('mcp.snippets.cursor')} value={snippets.data.snippets.cursor} />
          <CodeBlock label={t('mcp.snippets.generic')} value={snippets.data.snippets.generic} />
        </div>
      )}
    </div>
  );
}

// ── Zakładka: Konta serwisowe ────────────────────────────────────────────────

function ServiceAccountsTab() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const users = useUsers(true);
  const keys = useKeys();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<'viewer' | 'operator'>('viewer');

  const create = useMutation({
    mutationFn: () =>
      apiFetch<{ user: UserView }>('/api/v1/users', {
        method: 'POST',
        body: { kind: 'service', displayName: newName.trim(), role: newRole },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.show(t('mcp.service.createdToast'), 'ok');
      setCreateOpen(false);
      setNewName('');
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) =>
      apiFetch<{ user: UserView; revokedKeys: number; deletedSessions: number }>(`/api/v1/users/${id}`, {
        method: 'PATCH',
        body: { status },
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['mcp', 'keys'] });
      if (data.user.status === 'disabled') {
        // Komunikat o kaskadzie: unieważnione klucze + skasowane sesje.
        toast.show(
          t('mcp.service.disabledCascade', { keys: data.revokedKeys, sessions: data.deletedSessions }),
          'warn',
        );
      } else {
        toast.show(t('mcp.service.enabledToast'), 'ok');
      }
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  const serviceUsers = (users.data?.users ?? []).filter((u) => u.kind === 'service');
  const activeKeyCount = (userId: string): number =>
    (keys.data ?? []).filter((k) => k.userId === userId && k.status === 'active').length;

  const columns: readonly Column<UserView>[] = [
    { key: 'name', header: t('mcp.service.name'), render: (u) => u.displayName },
    { key: 'role', header: t('mcp.service.role'), render: (u) => u.role },
    {
      key: 'status',
      header: t('mcp.keys.status'),
      render: (u) => <StatusBadge status={u.status === 'active' ? 'active' : 'down'} />,
    },
    { key: 'keys', header: t('mcp.service.activeKeys'), render: (u) => String(activeKeyCount(u.id)) },
    { key: 'createdAt', header: t('mcp.service.createdAt'), render: (u) => formatDateTime(u.createdAt) },
    {
      key: 'actions',
      header: t('mcp.keys.actions'),
      render: (u) =>
        u.status === 'active' ? (
          <ConfirmButton
            className="btn btn-danger btn-sm"
            title={t('mcp.service.cascadeWarning')}
            onConfirm={() => setStatus.mutate({ id: u.id, status: 'disabled' })}
          >
            {t('mcp.service.disable')}
          </ConfirmButton>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setStatus.mutate({ id: u.id, status: 'active' })}
          >
            {t('mcp.service.enable')}
          </button>
        ),
    },
  ];

  if (users.isPending) return <Skeleton height="180px" />;
  if (users.isError) {
    return <EmptyState icon="⚠️" title={t('common.error')} description={errMsg(users.error)} />;
  }

  const createButton = (
    <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
      {t('mcp.service.create')}
    </button>
  );

  return (
    <div className="stack">
      <p className="callout callout-warn">{t('mcp.service.cascadeWarning')}</p>
      <div className="row">
        <span className="grow" />
        {createButton}
      </div>
      <DataTable
        columns={columns}
        rows={serviceUsers}
        rowKey={(u) => u.id}
        empty={
          <EmptyState
            icon="🤖"
            title={t('mcp.service.empty.title')}
            description={t('mcp.service.empty.description')}
            action={createButton}
          />
        }
      />
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('mcp.service.create')}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={newName.trim() === '' || create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <label className="field">
          <span>{t('mcp.service.name')}</span>
          <input
            className="input"
            value={newName}
            maxLength={120}
            placeholder={t('mcp.create.serviceNamePlaceholder')}
            onChange={(ev) => setNewName(ev.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('mcp.service.role')}</span>
          <select
            className="input"
            value={newRole}
            onChange={(ev) => setNewRole(ev.target.value === 'operator' ? 'operator' : 'viewer')}
          >
            <option value="viewer">viewer</option>
            <option value="operator">operator</option>
          </select>
          <span className="muted">{t('mcp.service.roleHint')}</span>
        </label>
      </Modal>
    </div>
  );
}

// ── Zakładka: Health ─────────────────────────────────────────────────────────

function HealthTab() {
  const health = useQuery({
    queryKey: ['mcp', 'health'],
    queryFn: () => apiFetch<McpHealthView>('/api/v1/mcp/health'),
    refetchInterval: 15_000,
  });
  const status = useStatus();
  const mcpComponent = status.data?.components.find((c) => c.id === 'mcp');

  if (health.isPending) return <Skeleton height="120px" />;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h3 style={{ margin: 0 }}>{t('mcp.health.title')}</h3>
          <span className="grow" />
          {health.data !== undefined && <StatusBadge status={health.data.ok ? 'ok' : 'down'} />}
        </div>
        {health.isError && <p className="callout callout-fail">{errMsg(health.error)}</p>}
        {health.data !== undefined && (
          <>
            <p style={{ margin: 0 }}>{health.data.detail}</p>
            <p className="muted" style={{ margin: 0 }}>
              {t('mcp.health.latency', { ms: health.data.latencyMs })}
            </p>
          </>
        )}
      </div>
      {mcpComponent !== undefined && (
        <div className="card stack">
          <div className="row">
            <h3 style={{ margin: 0 }}>{t('mcp.health.cockpit')}</h3>
            <span className="grow" />
            <StatusBadge status={mcpComponent.status} />
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {mcpComponent.label}: {mcpComponent.detail} ({mcpComponent.latencyMs} ms)
          </p>
          {status.data !== undefined && (
            <p className="muted" style={{ margin: 0 }}>
              {t('mcp.health.checkedAt', { at: formatDateTime(status.data.generatedAt) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Strona ───────────────────────────────────────────────────────────────────

const TAB_LABEL: Record<McpTab, PlKey> = {
  keys: 'mcp.tabs.keys',
  profiles: 'mcp.tabs.profiles',
  snippets: 'mcp.tabs.snippets',
  service: 'mcp.tabs.service',
  health: 'mcp.tabs.health',
};

export function McpPage() {
  const search = useSearch({ from: '/mcp' });
  const navigate = useNavigate();
  const me = useMe();
  const tab: McpTab = search.tab ?? 'keys';
  const isAdmin = me.data?.user.role === 'admin';

  // Konta serwisowe wymagają admina (GET /users jest admin-only).
  const tabs: McpTab[] = isAdmin
    ? ['keys', 'profiles', 'snippets', 'service', 'health']
    : ['keys', 'profiles', 'snippets', 'health'];

  function goTab(next: McpTab): void {
    void navigate({ to: '/mcp', search: next === 'keys' ? {} : { tab: next } });
  }

  return (
    <div className="stack">
      <h1 className="page-title">{t('nav.mcp')}</h1>
      <div className="tabs" role="tablist">
        {tabs.map((item) => (
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
      {tab === 'keys' && <KeysTab isAdmin={isAdmin} />}
      {tab === 'profiles' && <ProfilesTab isAdmin={isAdmin} />}
      {tab === 'snippets' && <SnippetsTab />}
      {tab === 'service' && isAdmin && <ServiceAccountsTab />}
      {tab === 'health' && <HealthTab />}
    </div>
  );
}
