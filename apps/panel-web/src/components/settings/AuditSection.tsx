/**
 * Zakładka Audyt (/settings): filtry w URL (from/to/action/actor/outcome),
 * JEDNA DataTable z wierszami-separatorami dat (groupByDay + formatDayHeading),
 * paginacja kursorowa po seq (Starsze/Najnowsze), drawer wpisu z diffem
 * before/after (diffObjects) i weryfikacja łańcucha hashy.
 * Kontrakt: apps/panel-api/src/routes/audit.ts.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { groupByDay } from '@/lib/settingsView';
import { t, formatDateTime } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardBody } from '@/ui/card';
import { CodeBlock } from '@/ui/code-block';
import { cn } from '@/ui/cn';
import { DataTable, type Column } from '@/ui/data-table';
import { EmptyState } from '@/ui/empty-state';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { Select } from '@/ui/select';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/ui/sheet';
import { diffObjects, formatDayHeading, formatDiffValue, type DiffRow } from './audit-core';

export interface AuditEntryDto {
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

export interface AuditFilters {
  from: string;
  to: string;
  action: string;
  actor: string;
  outcome: string;
}

const AUDIT_PAGE_LIMIT = 50;

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
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

/** Details-list diffa: Pole | Przed | Po; zmienione wiersze na bg-warn-tint. */
function DiffList({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="grid grid-cols-[minmax(80px,1fr)_2fr_2fr] gap-2 border-b border-border bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-text-secondary">
        <span>{t('system.audit.diffField')}</span>
        <span>{t('system.audit.before')}</span>
        <span>{t('system.audit.after')}</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          className={cn(
            'grid grid-cols-[minmax(80px,1fr)_2fr_2fr] gap-2 border-b border-border/60 px-2.5 py-1.5 text-xs last:border-b-0',
            row.changed && 'bg-warn-tint',
          )}
        >
          <span className="break-words font-mono text-text-secondary">{row.key}</span>
          <span className="break-words font-mono text-text">{row.before}</span>
          <span className="break-words font-mono text-text">{row.after}</span>
        </div>
      ))}
    </div>
  );
}

/** Metadane jako details-list klucz→wartość (obiekt) albo CodeBlock (reszta). */
function MetadataView({ metadata }: { metadata: unknown }) {
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
    const entries = Object.entries(metadata as Record<string, unknown>);
    return (
      <div className="overflow-hidden rounded-md border border-border">
        {entries.map(([key, value]) => (
          <div
            key={key}
            className="grid grid-cols-[minmax(80px,1fr)_2fr] gap-2 border-b border-border/60 px-2.5 py-1.5 text-xs last:border-b-0"
          >
            <span className="break-words font-mono text-text-secondary">{key}</span>
            <span className="break-words font-mono text-text">{formatDiffValue(value)}</span>
          </div>
        ))}
      </div>
    );
  }
  return <CodeBlock code={JSON.stringify(metadata, null, 2)} language="json" maxHeight={200} />;
}

function AuditEntrySheet({ entry, onClose }: { entry: AuditEntryDto; onClose: () => void }) {
  const diff = diffObjects(entry.before, entry.after);
  const hasBeforeAfter = entry.before !== null || entry.after !== null;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" size="lg">
        <SheetHeader>
          <SheetTitle>{t('system.audit.detailsTitle', { seq: entry.seq })}</SheetTitle>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={entry.outcome === 'success' ? 'ok' : 'fail'} dot>
              {entry.outcome === 'success' ? t('system.audit.outcomeSuccess') : t('system.audit.outcomeError')}
            </Badge>
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text">{entry.action}</code>
          </div>
          <div className="text-xs text-text-secondary">
            {formatDateTime(entry.at)} · {entry.actor} ({entry.actorType}
            {entry.role !== null ? `, ${entry.role}` : ''})
          </div>
          {entry.resourceType !== null && (
            <div className="text-xs text-text-secondary">
              {t('system.audit.resource')}: {entry.resourceType}
              {entry.resourceId !== null ? ` / ${entry.resourceId}` : ''}
            </div>
          )}

          {hasBeforeAfter && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text">{t('system.audit.diffTitle')}</span>
              {diff !== null ? (
                diff.length === 0 ? (
                  <p className="text-sm text-text-secondary">{t('system.audit.noChanges')}</p>
                ) : (
                  <DiffList rows={diff} />
                )
              ) : (
                <>
                  {entry.before !== null && (
                    <>
                      <span className="text-xs text-text-secondary">{t('system.audit.before')}</span>
                      <CodeBlock code={JSON.stringify(entry.before, null, 2)} language="json" maxHeight={200} />
                    </>
                  )}
                  {entry.after !== null && (
                    <>
                      <span className="text-xs text-text-secondary">{t('system.audit.after')}</span>
                      <CodeBlock code={JSON.stringify(entry.after, null, 2)} language="json" maxHeight={200} />
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {entry.metadata !== null && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text">{t('system.audit.metadata')}</span>
              <MetadataView metadata={entry.metadata} />
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/** Wiersz tabeli: separator dnia (nagłówek w tbody) albo wpis audytu. */
type AuditRow = { kind: 'day'; day: string } | { kind: 'entry'; entry: AuditEntryDto };

export interface AuditSectionProps {
  filters: AuditFilters;
  onFiltersChange: (next: AuditFilters) => void;
}

export function AuditSection({ filters, onFiltersChange }: AuditSectionProps) {
  // Stos kursorów: „Starsze" odkłada ostatni seq strony, „Najnowsze" czyści.
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
    setCursorStack([]);
    onFiltersChange({ ...filters, [key]: value });
  }

  const items = audit.data ?? [];
  const lastSeq = items.length > 0 ? (items[items.length - 1]?.seq ?? null) : null;
  const hasOlder = items.length === AUDIT_PAGE_LIMIT && lastSeq !== null;
  const rows: AuditRow[] = groupByDay(items).flatMap((group): AuditRow[] => [
    { kind: 'day', day: group.day },
    ...group.items.map((entry): AuditRow => ({ kind: 'entry', entry })),
  ]);

  // DataTable v2 nie wspiera colSpan — nagłówek dnia renderuje się w pierwszej
  // kolumnie zwykłego wiersza (pozostałe komórki puste).
  const columns: readonly Column<AuditRow>[] = [
    {
      key: 'at',
      header: t('system.audit.time'),
      render: (row) =>
        row.kind === 'day' ? (
          <span className="whitespace-nowrap text-xs font-semibold text-text">
            {formatDayHeading(row.day)}
          </span>
        ) : (
          formatDateTime(row.entry.at)
        ),
    },
    {
      key: 'actor',
      header: t('system.audit.actor'),
      hideBelow: 'sm',
      render: (row) => (row.kind === 'entry' ? row.entry.actor : null),
    },
    {
      key: 'action',
      header: t('system.audit.action'),
      render: (row) =>
        row.kind === 'entry' ? <code className="font-mono text-xs">{row.entry.action}</code> : null,
    },
    {
      key: 'resource',
      header: t('system.audit.resource'),
      hideBelow: 'md',
      render: (row) =>
        row.kind === 'entry' && row.entry.resourceType !== null
          ? `${row.entry.resourceType}${row.entry.resourceId !== null ? ` / ${row.entry.resourceId}` : ''}`
          : row.kind === 'entry'
            ? '—'
            : null,
    },
    {
      key: 'outcome',
      header: t('system.audit.outcome'),
      render: (row) =>
        row.kind === 'entry' ? (
          <Badge variant={row.entry.outcome === 'success' ? 'ok' : 'fail'} dot>
            {row.entry.outcome === 'success' ? t('system.audit.outcomeSuccess') : t('system.audit.outcomeError')}
          </Badge>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">{t('system.audit.title')}</h3>
        <Button size="sm" loading={verify.isPending} onClick={() => verify.mutate()}>
          {t('system.audit.verify')}
        </Button>
      </div>

      {verify.isSuccess &&
        (verify.data.valid ? (
          <Alert variant="ok">{t('system.audit.verifyOk', { checked: verify.data.checked })}</Alert>
        ) : (
          <Alert variant="fail">
            {t('system.audit.verifyFail', {
              problems: verify.data.problems.length,
              seq: verify.data.firstBrokenSeq ?? '—',
            })}
          </Alert>
        ))}
      {verify.isError && <Alert variant="fail">{errMsg(verify.error)}</Alert>}

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('system.audit.from')} className="w-36">
          <Input type="date" value={filters.from} onChange={(ev) => setFilter('from', ev.target.value)} />
        </Field>
        <Field label={t('system.audit.to')} className="w-36">
          <Input type="date" value={filters.to} onChange={(ev) => setFilter('to', ev.target.value)} />
        </Field>
        <Field label={t('system.audit.action')} className="w-44">
          <Input value={filters.action} onChange={(ev) => setFilter('action', ev.target.value)} />
        </Field>
        <Field label={t('system.audit.actor')} className="w-40">
          <Input value={filters.actor} onChange={(ev) => setFilter('actor', ev.target.value)} />
        </Field>
        <Field label={t('system.audit.outcome')} className="w-36">
          <Select value={filters.outcome} onChange={(ev) => setFilter('outcome', ev.target.value)}>
            <option value="">{t('system.actions.all')}</option>
            <option value="success">{t('system.audit.outcomeSuccess')}</option>
            <option value="error">{t('system.audit.outcomeError')}</option>
          </Select>
        </Field>
      </div>

      {audit.isError ? (
        <Alert variant="fail">{errMsg(audit.error)}</Alert>
      ) : (
        <Card>
          <CardBody className="p-0 px-1">
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => (row.kind === 'day' ? `day-${row.day}` : String(row.entry.seq))}
              loading={audit.isPending}
              onRowClick={(row) => {
                if (row.kind === 'entry') setOpenEntry(row.entry);
              }}
              empty={
                <EmptyState
                  icon={ScrollText}
                  title={t('system.audit.emptyTitle')}
                  description={t('system.audit.emptyDesc')}
                />
              }
            />
          </CardBody>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div>
          {cursorStack.length > 0 && (
            <Button size="sm" onClick={() => setCursorStack([])}>
              {t('system.audit.newest')}
            </Button>
          )}
        </div>
        {hasOlder && (
          <Button
            size="sm"
            onClick={() => {
              if (lastSeq !== null) setCursorStack((prev) => [...prev, lastSeq]);
            }}
          >
            {t('system.audit.older')}
          </Button>
        )}
      </div>

      {openEntry !== null && <AuditEntrySheet entry={openEntry} onClose={() => setOpenEntry(null)} />}
    </div>
  );
}
