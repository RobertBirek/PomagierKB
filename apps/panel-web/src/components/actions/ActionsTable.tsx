/**
 * Tabela akcji długobieżnych (zakładka System w /settings; /overview linkuje
 * tu deep-linkiem). Filtry (status, typ, strona) KONTROLOWANE przez stronę —
 * /settings trzyma je w URL (search-params). Licznik z meta.total
 * (apiFetchWithMeta), wiersz otwiera ActionDetailsSheet.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { apiFetchWithMeta, ApiError } from '@/lib/api';
import { t, formatDateTime, type PlKey } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Card, CardBody } from '@/ui/card';
import { DataTable, type Column } from '@/ui/data-table';
import { EmptyState } from '@/ui/empty-state';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { Select } from '@/ui/select';
import {
  actionStatusVariant,
  KNOWN_ACTION_TYPES,
  OTHER_ACTION_TYPE,
  typeFilterFromUrl,
} from './actions-core';
import { ActionDetailsSheet } from './ActionDetailsSheet';

export interface ActionDto {
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

export interface ActionsFilters {
  /** '' = wszystkie. */
  status: string;
  /** '' = wszystkie; dowolny string (znany typ albo własny z „inny…"). */
  type: string;
  page: number;
}

const ACTION_STATUS_OPTIONS: { value: string; labelKey: PlKey }[] = [
  { value: 'running', labelKey: 'status.running' },
  { value: 'success', labelKey: 'status.done' },
  { value: 'error', labelKey: 'status.failed' },
  { value: 'cancelled', labelKey: 'status.canceled' },
];

export const ACTIONS_PAGE_LIMIT = 20;

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

export interface ActionsTableProps {
  filters: ActionsFilters;
  onFiltersChange: (next: ActionsFilters) => void;
}

export function ActionsTable({ filters, onFiltersChange }: ActionsTableProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  // „inny…" wybrane, ale pole własnego typu jeszcze puste — stan lokalny,
  // bo pusty typ w URL mapowałby Select z powrotem na „wszystkie".
  const [otherPicked, setOtherPicked] = useState(false);

  const derived = typeFilterFromUrl(filters.type);
  const selectValue = otherPicked ? OTHER_ACTION_TYPE : derived.select;
  const showCustomInput = selectValue === OTHER_ACTION_TYPE;
  // Pole własnego typu trzyma stan lokalnie (URL nadąża za wpisywaniem) —
  // dzięki temu wpisanie znanego typu nie przełącza Selecta w trakcie pisania.
  const [customType, setCustomType] = useState(() => derived.custom);

  const params = new URLSearchParams();
  if (filters.status !== '') params.set('status', filters.status);
  if (filters.type.trim() !== '') params.set('type', filters.type.trim());
  params.set('page', String(filters.page));
  params.set('limit', String(ACTIONS_PAGE_LIMIT));

  const actions = useQuery({
    queryKey: ['actions', { status: filters.status, type: filters.type.trim(), page: filters.page }],
    queryFn: () => apiFetchWithMeta<{ items: ActionDto[] }>(`/api/v1/actions?${params.toString()}`),
  });

  const items = actions.data?.data.items ?? [];
  const total = actions.data?.meta?.total;

  const columns: readonly Column<ActionDto>[] = [
    { key: 'type', header: t('system.actions.type'), render: (a) => a.type },
    {
      key: 'resource',
      header: t('system.actions.resource'),
      hideBelow: 'md',
      render: (a) =>
        a.resource !== null ? <span className="font-mono text-xs">{a.resource}</span> : '—',
    },
    {
      key: 'status',
      header: t('system.actions.status'),
      render: (a) => (
        <Badge variant={actionStatusVariant(a.status)} dot>
          {a.statusLabel}
        </Badge>
      ),
    },
    {
      key: 'startedBy',
      header: t('system.actions.startedBy'),
      hideBelow: 'md',
      render: (a) => a.startedBy ?? '—',
    },
    { key: 'startedAt', header: t('system.actions.startedAt'), render: (a) => formatDateTime(a.startedAt) },
    {
      key: 'finishedAt',
      header: t('system.actions.finishedAt'),
      hideBelow: 'sm',
      render: (a) => (a.finishedAt !== null ? formatDateTime(a.finishedAt) : '—'),
    },
  ];

  function setStatus(value: string): void {
    onFiltersChange({ ...filters, status: value, page: 1 });
  }

  function setTypeFromSelect(value: string): void {
    if (value === OTHER_ACTION_TYPE) {
      setOtherPicked(true);
      if (derived.select !== OTHER_ACTION_TYPE) {
        // znany typ był w URL → czyścimy filtr, pole własne startuje puste
        setCustomType('');
        onFiltersChange({ ...filters, type: '', page: 1 });
      } else {
        setCustomType(derived.custom);
      }
      return;
    }
    setOtherPicked(false);
    onFiltersChange({ ...filters, type: value, page: 1 });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('system.actions.filterStatus')} className="w-40">
          <Select value={filters.status} onChange={(ev) => setStatus(ev.target.value)}>
            <option value="">{t('system.actions.all')}</option>
            {ACTION_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('system.actions.type')} className="w-44">
          <Select value={selectValue} onChange={(ev) => setTypeFromSelect(ev.target.value)}>
            <option value="">{t('system.actions.all')}</option>
            {KNOWN_ACTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
            <option value={OTHER_ACTION_TYPE}>{t('system.actions.typeOther')}</option>
          </Select>
        </Field>
        {showCustomInput && (
          <Field label={t('system.actions.typeCustom')} className="w-48">
            <Input
              value={customType}
              placeholder={t('system.actions.typeCustomPlaceholder')}
              onChange={(ev) => {
                setCustomType(ev.target.value);
                onFiltersChange({ ...filters, type: ev.target.value, page: 1 });
              }}
            />
          </Field>
        )}
      </div>

      {actions.isError ? (
        <Alert variant="fail">{errMsg(actions.error)}</Alert>
      ) : (
        <Card>
          <CardBody className="p-0 px-1">
            <DataTable
              columns={columns}
              rows={items}
              rowKey={(a) => a.id}
              loading={actions.isPending}
              onRowClick={(a) => setOpenId(a.id)}
              pagination={{
                page: filters.page,
                pageSize: ACTIONS_PAGE_LIMIT,
                onPageChange: (page) => onFiltersChange({ ...filters, page }),
                ...(total !== undefined
                  ? { total }
                  : { hasNext: items.length === ACTIONS_PAGE_LIMIT }),
              }}
              empty={
                <EmptyState
                  icon={ListChecks}
                  title={t('system.actions.emptyTitle')}
                  description={t('system.actions.emptyDesc')}
                />
              }
              mobileCard={(a) => (
                <button
                  type="button"
                  className="w-full rounded-lg border border-border bg-surface p-3 text-left hover:bg-surface-2"
                  onClick={() => setOpenId(a.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-text">{a.type}</span>
                    <Badge variant={actionStatusVariant(a.status)} dot>
                      {a.statusLabel}
                    </Badge>
                  </div>
                  {a.resource !== null && (
                    <div className="mt-1 truncate font-mono text-xs text-text-secondary">{a.resource}</div>
                  )}
                  <div className="mt-1 text-xs text-text-tertiary">
                    {formatDateTime(a.startedAt)}
                    {a.startedBy !== null && <> · {a.startedBy}</>}
                  </div>
                </button>
              )}
            />
          </CardBody>
        </Card>
      )}

      {openId !== null && <ActionDetailsSheet actionId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
