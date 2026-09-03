/**
 * /mcp v2 (admin): klucze API (6 kolumn, filtr+sort kliencki, sheet
 * szczegółów, rotacja/unieważnienie przez AlertDialog z konsekwencjami),
 * profile (formularz w Dialogu z błędami per pole, przewijalna lista KB),
 * snippety (CodeBlock z kitu), konta serwisowe (disable z kaskadą i
 * LICZNIKIEM kluczy) i health (odświeżanie ręczne + latencja jako Badge).
 * Kontrakt: apps/panel-api/src/routes/{mcp-admin,users}.ts.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Blocks, Bot, KeyRound, MoreHorizontal, Plus, RefreshCw, RotateCw, SearchX, ShieldOff, TriangleAlert } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { keyBadgeInfo, daysUntil, KEY_EXPIRY_WARN_DAYS } from '@/lib/mcp';
import { useMe } from '@/hooks/useMe';
import { useStatus } from '@/hooks/useStatus';
import { t, formatDateTime, formatNumber, type PlKey } from '@/i18n/t';
import { AlertDialog } from '@/ui/alert-dialog';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button, IconButton } from '@/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/ui/card';
import { CodeBlock } from '@/ui/code-block';
import { DataTable, type Column, type SortState } from '@/ui/data-table';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { EmptyState } from '@/ui/empty-state';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { PageContainer } from '@/ui/page-container';
import { PageHeader } from '@/ui/page-header';
import { SearchInput } from '@/ui/search-input';
import { Select } from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { useToast } from '@/ui/toast';
import { StatusBadgeV2 } from '@/components/kb/StatusBadgeV2';
import { CreateKeyDialog } from '@/components/mcp/CreateKeyDialog';
import { KeyDetailsSheet } from '@/components/mcp/KeyDetailsSheet';
import { ProfileFormDialog } from '@/components/mcp/ProfileFormDialog';
import { RawKeyDialog } from '@/components/mcp/RawKeyDialog';
import { countActiveKeys, filterKeys, latencyVariant, sortKeys } from '@/components/mcp/mcp-page-lib';
import type {
  ApiKeyView,
  KbListView,
  McpHealthView,
  McpProfileView,
  McpSnippetsView,
  UserView,
} from '@/components/mcp/types';
import type { McpTab } from '../router';

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

// ── Zakładka: Klucze API ─────────────────────────────────────────────────────

function KeysTab({ isAdmin }: { isAdmin: boolean }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const toast = useToast();
  const keys = useKeys();
  const profiles = useProfiles();
  const users = useUsers(isAdmin);

  const [createOpen, setCreateOpen] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [detailsKey, setDetailsKey] = useState<ApiKeyView | null>(null);
  const [rotateKey, setRotateKey] = useState<ApiKeyView | null>(null);
  const [revokeKey, setRevokeKey] = useState<ApiKeyView | null>(null);

  const usersById = useMemo(() => {
    const map = new Map<string, UserView>();
    for (const u of users.data?.users ?? []) map.set(u.id, u);
    return map;
  }, [users.data]);

  function ownerName(userId: string): string {
    if (userId === me.data?.user.id) return me.data.user.displayName;
    return usersById.get(userId)?.displayName ?? userId;
  }

  const rotate = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ key: ApiKeyView; raw: string }>(`/api/v1/mcp/keys/${id}/rotate`, { method: 'POST' }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['mcp', 'keys'] });
      toast.show(t('mcp.toast.keyRotated'), 'ok');
      setRotateKey(null);
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
      setRevokeKey(null);
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  const nowMs = Date.now();
  const visible = useMemo(
    () => sortKeys(filterKeys(keys.data ?? [], query, ownerName), sort, ownerName),
    // ownerName zmienia się razem z danymi users/me — te są w zależnościach.
    [keys.data, query, sort, usersById, me.data],
  );

  const keyMenu = (k: ApiKeyView) =>
    k.status === 'active' ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton aria-label={t('mcp.keys.menu', { label: k.label })}>
            <MoreHorizontal size={16} aria-hidden="true" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRotateKey(k)}>
            <RotateCw size={16} aria-hidden="true" />
            {t('mcp.keys.rotate')}
          </DropdownMenuItem>
          <DropdownMenuItem destructive onSelect={() => setRevokeKey(k)}>
            <ShieldOff size={16} aria-hidden="true" />
            {t('mcp.keys.revoke')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  /** Data wygaśnięcia + Badge warn, gdy aktywnemu kluczowi zostało ≤14 dni. */
  const expiresCell = (k: ApiKeyView) => {
    const days = k.status === 'active' ? daysUntil(k.expiresAt, nowMs) : null;
    const warn = days !== null && days > 0 && days <= KEY_EXPIRY_WARN_DAYS;
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span>{formatDateTime(k.expiresAt)}</span>
        {warn && <Badge variant="warn">{t('mcp.keys.daysLeft', { days: days ?? 0 })}</Badge>}
      </div>
    );
  };

  const statusCell = (k: ApiKeyView) => {
    const info = keyBadgeInfo(k.status, k.expiresAt, nowMs);
    return (
      <Badge variant={info.variant} dot>
        {t(info.labelKey)}
      </Badge>
    );
  };

  const columns: readonly Column<ApiKeyView>[] = [
    {
      key: 'label',
      header: t('mcp.keys.label'),
      sortable: true,
      render: (k) => (
        <div className="flex flex-col gap-0.5 py-1.5">
          <span className="font-medium text-text">{k.label}</span>
          <code className="font-mono text-xs text-text-tertiary">{k.prefix}…</code>
        </div>
      ),
    },
    { key: 'owner', header: t('mcp.keys.owner'), sortable: true, hideBelow: 'md', render: (k) => ownerName(k.userId) },
    {
      key: 'profile',
      header: t('mcp.keys.profile'),
      sortable: true,
      hideBelow: 'sm',
      render: (k) => <code className="font-mono text-xs">{k.profileId}</code>,
    },
    { key: 'expires', header: t('mcp.keys.expires'), sortable: true, render: expiresCell },
    { key: 'status', header: t('mcp.keys.status'), sortable: true, render: statusCell },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (k) => (
        <div className="flex justify-end" onClick={(ev) => ev.stopPropagation()}>
          {keyMenu(k)}
        </div>
      ),
    },
  ];

  const mobileCard = (k: ApiKeyView) => (
    <div
      role="button"
      tabIndex={0}
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
      onClick={() => setDetailsKey(k)}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          setDetailsKey(k);
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-text">{k.label}</span>
          <code className="font-mono text-xs text-text-tertiary">{k.prefix}…</code>
        </div>
        <div onClick={(ev) => ev.stopPropagation()}>{keyMenu(k)}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {statusCell(k)}
        <span className="text-xs text-text-secondary">{ownerName(k.userId)}</span>
      </div>
      <div className="text-xs text-text-secondary">
        {t('mcp.keys.expires')}: {formatDateTime(k.expiresAt)}
      </div>
    </div>
  );

  if (keys.isError) {
    return (
      <EmptyState
        icon={TriangleAlert}
        title={t('common.error')}
        description={errMsg(keys.error)}
        action={<Button variant="primary" onClick={() => void keys.refetch()}>{t('common.retry')}</Button>}
      />
    );
  }

  const createButton = (
    <Button variant="primary" iconLeft={<Plus size={16} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>
      {t('mcp.keys.create')}
    </Button>
  );

  const emptyState =
    (keys.data ?? []).length === 0 ? (
      <EmptyState
        icon={KeyRound}
        title={t('mcp.keys.empty.title')}
        description={t('mcp.keys.empty.description')}
        action={createButton}
      />
    ) : (
      <EmptyState icon={SearchX} title={t('mcp.keys.noMatches')} />
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="w-full sm:max-w-72"
          placeholder={t('mcp.keys.searchPlaceholder')}
          onDebouncedChange={setQuery}
        />
        <span className="ml-auto text-xs text-text-secondary">
          {t('mcp.keys.count', { count: formatNumber(visible.length) })}
        </span>
        {createButton}
      </div>

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(k) => k.id}
        {...(sort !== undefined ? { sort } : {})}
        onSortChange={setSort}
        onRowClick={setDetailsKey}
        loading={keys.isPending}
        mobileCard={mobileCard}
        empty={emptyState}
      />

      <KeyDetailsSheet apiKey={detailsKey} ownerName={ownerName} onClose={() => setDetailsKey(null)} />

      <AlertDialog
        open={rotateKey !== null}
        onOpenChange={(open) => !open && setRotateKey(null)}
        title={t('mcp.rotate.title')}
        objectName={rotateKey?.label ?? ''}
        consequences={[t('mcp.rotate.c1'), t('mcp.rotate.c2')]}
        confirmLabel={t('mcp.keys.rotate')}
        loading={rotate.isPending}
        onConfirm={() => rotateKey !== null && rotate.mutate(rotateKey.id)}
      />

      <AlertDialog
        open={revokeKey !== null}
        onOpenChange={(open) => !open && setRevokeKey(null)}
        title={t('mcp.revoke.title')}
        objectName={revokeKey?.label ?? ''}
        consequences={[t('mcp.revoke.c1'), t('mcp.revoke.c2')]}
        confirmLabel={t('mcp.keys.revoke')}
        destructive
        loading={revoke.isPending}
        onConfirm={() => revokeKey !== null && revoke.mutate(revokeKey.id)}
      />

      <CreateKeyDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        isAdmin={isAdmin}
        profiles={profiles.data ?? []}
        serviceUsers={(users.data?.users ?? []).filter((u) => u.kind === 'service')}
        onRaw={setRaw}
      />
      <RawKeyDialog raw={raw} onClose={() => setRaw(null)} />
    </div>
  );
}

// ── Zakładka: Profile ────────────────────────────────────────────────────────

function ProfilesTab({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const profiles = useProfiles();
  const kbs = useKbs();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<McpProfileView | null>(null);
  const [deleting, setDeleting] = useState<McpProfileView | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch<{ deleted: boolean }>(`/api/v1/mcp/profiles/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mcp', 'profiles'] });
      toast.show(t('mcp.toast.profileDeleted'), 'ok');
      setDeleting(null);
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  const namespaces = (kbs.data?.items ?? []).map((kb) => kb.namespace);

  const columns: readonly Column<McpProfileView>[] = [
    { key: 'id', header: t('mcp.profiles.id'), render: (p) => <code className="font-mono text-xs">{p.id}</code> },
    { key: 'name', header: t('mcp.profiles.name'), render: (p) => p.name },
    {
      key: 'namespaces',
      header: t('mcp.profiles.namespaces'),
      hideBelow: 'sm',
      render: (p) => (p.namespaces === null ? t('mcp.profiles.allNamespaces') : p.namespaces.join(', ')),
    },
    {
      key: 'tools',
      header: t('mcp.profiles.tools'),
      hideBelow: 'md',
      render: (p) => <span className="text-text-secondary">{p.tools.join(', ')}</span>,
    },
    {
      key: 'enabled',
      header: t('mcp.keys.status'),
      render: (p) => <StatusBadgeV2 status={p.enabled ? 'active' : 'down'} />,
    },
    ...(isAdmin
      ? ([
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (p: McpProfileView) => (
              <div className="flex justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(p);
                    setFormOpen(true);
                  }}
                >
                  {t('mcp.profiles.edit')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setDeleting(p)}>
                  {t('mcp.profiles.delete')}
                </Button>
              </div>
            ),
          },
        ] satisfies Column<McpProfileView>[])
      : []),
  ];

  if (profiles.isPending) return <Skeleton className="h-44 w-full" />;
  if (profiles.isError) {
    return <EmptyState icon={TriangleAlert} title={t('common.error')} description={errMsg(profiles.error)} />;
  }

  const createButton = isAdmin ? (
    <Button
      variant="primary"
      iconLeft={<Plus size={16} aria-hidden="true" />}
      onClick={() => {
        setEditing(null);
        setFormOpen(true);
      }}
    >
      {t('mcp.profiles.create')}
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-3">
      {createButton !== undefined && <div className="flex justify-end">{createButton}</div>}
      <DataTable
        columns={columns}
        rows={profiles.data}
        rowKey={(p) => p.id}
        empty={
          <EmptyState
            icon={Blocks}
            title={t('mcp.profiles.empty.title')}
            description={t('mcp.profiles.empty.description')}
            {...(createButton !== undefined ? { action: createButton } : {})}
          />
        }
      />
      {formOpen && (
        <ProfileFormDialog
          key={editing?.id ?? '∅new'}
          open={formOpen}
          onClose={() => setFormOpen(false)}
          editing={editing}
          namespaces={namespaces}
        />
      )}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('mcp.profiles.deleteTitle')}
        objectName={deleting?.name ?? ''}
        consequences={[t('mcp.profiles.deleteC1'), t('mcp.profiles.deleteC2')]}
        confirmLabel={t('mcp.profiles.delete')}
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting !== null && remove.mutate(deleting.id)}
      />
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

  if (profiles.isPending) return <Skeleton className="h-44 w-full" />;
  if (enabledProfiles.length === 0) {
    return (
      <EmptyState
        icon={Blocks}
        title={t('mcp.profiles.empty.title')}
        description={t('mcp.profiles.empty.description')}
      />
    );
  }

  const blocks: readonly { labelKey: PlKey; code: string }[] =
    snippets.data !== undefined
      ? [
          { labelKey: 'mcp.snippets.claudeCode', code: snippets.data.snippets.claudeCode },
          { labelKey: 'mcp.snippets.cursor', code: snippets.data.snippets.cursor },
          { labelKey: 'mcp.snippets.generic', code: snippets.data.snippets.generic },
        ]
      : [];

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('mcp.snippets.pickProfile')} className="max-w-sm">
        <Select value={effectiveId} onChange={(ev) => setProfileId(ev.target.value)}>
          {enabledProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.id})
            </option>
          ))}
        </Select>
      </Field>
      {snippets.isPending && <Skeleton className="h-32 w-full" />}
      {snippets.isError && <Alert variant="fail">{errMsg(snippets.error)}</Alert>}
      {snippets.data !== undefined && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-secondary">{t('mcp.snippets.hint', { placeholder: '<TWÓJ_KLUCZ>' })}</p>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text">{t('mcp.snippets.url')}</span>
            <CodeBlock inline code={snippets.data.url} label={t('mcp.snippets.url')} />
          </div>
          {blocks.map((block) => (
            <div key={block.labelKey} className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text">{t(block.labelKey)}</span>
              <CodeBlock code={block.code} label={t(block.labelKey)} />
            </div>
          ))}
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
  const [disabling, setDisabling] = useState<UserView | null>(null);

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
      setDisabling(null);
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
  const disablingKeyCount = disabling !== null ? countActiveKeys(keys.data ?? [], disabling.id) : 0;

  const columns: readonly Column<UserView>[] = [
    { key: 'name', header: t('mcp.service.name'), render: (u) => u.displayName },
    { key: 'role', header: t('mcp.service.role'), hideBelow: 'sm', render: (u) => u.role },
    {
      key: 'status',
      header: t('mcp.keys.status'),
      render: (u) => <StatusBadgeV2 status={u.status === 'active' ? 'active' : 'down'} />,
    },
    {
      key: 'keys',
      header: t('mcp.service.activeKeys'),
      align: 'right',
      render: (u) => <span className="tabular-nums">{formatNumber(countActiveKeys(keys.data ?? [], u.id))}</span>,
    },
    {
      key: 'createdAt',
      header: t('mcp.service.createdAt'),
      hideBelow: 'md',
      render: (u) => formatDateTime(u.createdAt),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (u) => (
        <div className="flex justify-end">
          {u.status === 'active' ? (
            <Button size="sm" variant="danger" onClick={() => setDisabling(u)}>
              {t('mcp.service.disable')}
            </Button>
          ) : (
            <Button
              size="sm"
              loading={setStatus.isPending && setStatus.variables?.id === u.id}
              onClick={() => setStatus.mutate({ id: u.id, status: 'active' })}
            >
              {t('mcp.service.enable')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  if (users.isPending) return <Skeleton className="h-44 w-full" />;
  if (users.isError) {
    return <EmptyState icon={TriangleAlert} title={t('common.error')} description={errMsg(users.error)} />;
  }

  const createButton = (
    <Button variant="primary" iconLeft={<Plus size={16} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>
      {t('mcp.service.create')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      <Alert variant="warn">{t('mcp.service.cascadeWarning')}</Alert>
      <div className="flex justify-end">{createButton}</div>
      <DataTable
        columns={columns}
        rows={serviceUsers}
        rowKey={(u) => u.id}
        empty={
          <EmptyState
            icon={Bot}
            title={t('mcp.service.empty.title')}
            description={t('mcp.service.empty.description')}
            action={createButton}
          />
        }
      />

      {/* Disable = kaskada: AlertDialog z LICZNIKIEM aktywnych kluczy konta. */}
      <AlertDialog
        open={disabling !== null}
        onOpenChange={(open) => !open && setDisabling(null)}
        title={t('mcp.service.disableTitle')}
        objectName={disabling?.displayName ?? ''}
        consequences={[
          t('mcp.service.disableC1', { n: disablingKeyCount }),
          t('mcp.service.disableC2'),
          t('mcp.service.disableC3'),
        ]}
        confirmLabel={t('mcp.service.disable')}
        destructive
        loading={setStatus.isPending}
        onConfirm={() => disabling !== null && setStatus.mutate({ id: disabling.id, status: 'disabled' })}
      />

      <Dialog open={createOpen} onOpenChange={(open) => !open && setCreateOpen(false)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('mcp.service.create')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <Field label={t('mcp.service.name')} required>
              <Input
                value={newName}
                maxLength={120}
                placeholder={t('mcp.create.serviceNamePlaceholder')}
                onChange={(ev) => setNewName(ev.target.value)}
              />
            </Field>
            <Field label={t('mcp.service.role')} hint={t('mcp.service.roleHint')}>
              <Select
                value={newRole}
                onChange={(ev) => setNewRole(ev.target.value === 'operator' ? 'operator' : 'viewer')}
              >
                <option value="viewer">viewer</option>
                <option value="operator">operator</option>
              </Select>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={newName.trim() === ''}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

  if (health.isPending) return <Skeleton className="h-32 w-full" />;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="grow">{t('mcp.health.title')}</CardTitle>
          {health.data !== undefined && <StatusBadgeV2 status={health.data.ok ? 'ok' : 'down'} />}
          <IconButton
            aria-label={t('mcp.health.refresh')}
            loading={health.isFetching}
            onClick={() => void health.refetch()}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </IconButton>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          {health.isError && <Alert variant="fail">{errMsg(health.error)}</Alert>}
          {health.data !== undefined && (
            <>
              <p className="text-sm text-text">{health.data.detail}</p>
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <Badge variant={latencyVariant(health.data.latencyMs)}>
                  {t('mcp.health.latency', { ms: health.data.latencyMs })}
                </Badge>
                {health.dataUpdatedAt > 0 && (
                  <span>
                    {t('mcp.health.refreshedAt', {
                      at: formatDateTime(new Date(health.dataUpdatedAt).toISOString()),
                    })}
                  </span>
                )}
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {mcpComponent !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle className="grow">{t('mcp.health.cockpit')}</CardTitle>
            <StatusBadgeV2 status={mcpComponent.status} />
          </CardHeader>
          <CardBody className="flex flex-col gap-1">
            <p className="text-sm text-text-secondary">
              {mcpComponent.label}: {mcpComponent.detail} ({mcpComponent.latencyMs} ms)
            </p>
            {status.data !== undefined && (
              <p className="text-xs text-text-tertiary">
                {t('mcp.health.checkedAt', { at: formatDateTime(status.data.generatedAt) })}
              </p>
            )}
          </CardBody>
        </Card>
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

  function goTab(next: string): void {
    const value = next as McpTab;
    void navigate({ to: '/mcp', search: value === 'keys' ? {} : { tab: value }, replace: true });
  }

  return (
    <PageContainer width="settings">
      <Tabs value={tab} onValueChange={goTab}>
        <PageHeader
          title={t('nav.mcp')}
          description={t('mcp.pageDescription')}
          tabs={
            <TabsList>
              {tabs.map((item) => (
                <TabsTrigger key={item} value={item}>
                  {t(TAB_LABEL[item])}
                </TabsTrigger>
              ))}
            </TabsList>
          }
        />
        <TabsContent value="keys">
          <KeysTab isAdmin={isAdmin} />
        </TabsContent>
        <TabsContent value="profiles">
          <ProfilesTab isAdmin={isAdmin} />
        </TabsContent>
        <TabsContent value="snippets">
          <SnippetsTab />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="service">
            <ServiceAccountsTab />
          </TabsContent>
        )}
        <TabsContent value="health">
          <HealthTab />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
