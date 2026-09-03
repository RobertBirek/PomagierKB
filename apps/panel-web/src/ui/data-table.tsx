/**
 * DataTable v2 — gęsta tabela danych (Linear-like): sort/paginacja/selekcja
 * KONTROLOWANE przez stronę; tu tylko render + a11y. Czysta logika (zakres
 * pagera, cykl sortu, stan „zaznacz wszystkie") w data-table-core.ts.
 * Nadzbiór stylu wywołań components/DataTable.tsx (legacy — migracja w Fazie 3).
 */
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
} from 'lucide-react';
import { cn } from '@/ui/cn';
import { Checkbox } from '@/ui/checkbox';
import { Skeleton } from '@/ui/skeleton';
import { t } from '@/i18n/t';
import { nextSort, pageRange, selectionState, type SortState } from '@/ui/data-table-core';

export type { SortState };

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Kolumna sortowalna — przycisk w th woła onSortChange (cykl asc→desc→brak). */
  sortable?: boolean;
  width?: string;
  align?: 'left' | 'right';
  /** Ukryj poniżej breakpointu (hidden sm:table-cell / hidden md:table-cell). */
  hideBelow?: 'sm' | 'md';
}

export interface PaginationProps {
  /** Strona od 1. */
  page: number;
  pageSize: number;
  /** Znany licznik → pager „{from}–{to} z {total}". */
  total?: number;
  /** Bez licznika → fallback „Strona {page}" + hasNext steruje przyciskiem. */
  hasNext?: boolean;
  onPageChange: (page: number) => void;
}

export interface SelectionProps {
  selected: readonly string[];
  onToggleRow: (id: string) => void;
  onToggleAll: (visibleIds: readonly string[], select: boolean) => void;
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Sortowanie KONTROLOWANE; undefined w callbacku = wyłącz sortowanie. */
  sort?: SortState;
  onSortChange?: (sort: SortState | undefined) => void;
  pagination?: PaginationProps;
  selection?: SelectionProps;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  /** Liczba wierszy Skeleton przy loading (domyślnie 5). */
  loadingRows?: number;
  /** Wysokość wiersza: default 36px / compact 32px. */
  density?: 'default' | 'compact';
  stickyHeader?: boolean;
  /** Zawartość przy pustych rows (np. <EmptyState/>). */
  empty?: ReactNode;
  /** <768px: lista kart zamiast tabeli. */
  mobileCard?: (row: T) => ReactNode;
}

const HIDE_BELOW: Record<'sm' | 'md', string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
};

const ICON_BTN =
  'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border ' +
  'bg-surface text-text-secondary hover:bg-surface-2 hover:text-text ' +
  'disabled:pointer-events-none disabled:opacity-40';

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  pagination,
  selection,
  onRowClick,
  loading,
  loadingRows = 5,
  density = 'default',
  stickyHeader,
  empty,
  mobileCard,
}: DataTableProps<T>) {
  const isLoading = loading === true;
  if (!isLoading && rows.length === 0 && empty !== undefined) return <>{empty}</>;

  const rowH = density === 'compact' ? 'h-8' : 'h-9';
  const visibleIds = rows.map(rowKey);
  const selState = selection !== undefined ? selectionState(selection.selected, visibleIds) : 'none';
  const tdBase = 'px-3 text-sm border-b border-border/60';
  const thBase = 'px-3 h-8 border-b border-border font-medium whitespace-nowrap';

  function headerCell(col: Column<T>): ReactNode {
    if (col.sortable !== true || onSortChange === undefined) return col.header;
    const activeDir = sort?.key === col.key ? sort.dir : undefined;
    const Icon = activeDir === 'asc' ? ArrowUp : activeDir === 'desc' ? ArrowDown : ChevronsUpDown;
    return (
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1 hover:text-text',
          col.align === 'right' && 'flex-row-reverse',
          activeDir !== undefined && 'text-text',
        )}
        {...(typeof col.header === 'string'
          ? { title: t('table.sortBy', { column: col.header }) }
          : {})}
        onClick={() => onSortChange(nextSort(sort, col.key))}
      >
        {col.header}
        <Icon
          size={14}
          aria-hidden="true"
          className={activeDir !== undefined ? 'text-text' : 'text-text-tertiary'}
        />
      </button>
    );
  }

  function ariaSort(col: Column<T>): 'ascending' | 'descending' | 'none' | undefined {
    if (col.sortable !== true) return undefined;
    if (sort?.key !== col.key) return 'none';
    return sort.dir === 'asc' ? 'ascending' : 'descending';
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLTableRowElement>, row: T): void {
    if (onRowClick === undefined) return;
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick(row);
    }
  }

  const skeletonRows = Array.from({ length: loadingRows }, (_, i) => (
    <tr key={`skeleton-${i}`}>
      {selection !== undefined && (
        <td className={cn(tdBase, rowH, 'w-8')}>
          <Skeleton className="h-4 w-4" />
        </td>
      )}
      {columns.map((col) => (
        <td
          key={col.key}
          className={cn(tdBase, rowH, col.hideBelow !== undefined && HIDE_BELOW[col.hideBelow])}
        >
          <Skeleton className="h-4 w-full max-w-40" />
        </td>
      ))}
    </tr>
  ));

  const table = (
    <table className="w-full border-collapse text-left">
      <thead
        className={cn(
          'text-xs text-text-secondary font-medium bg-surface',
          stickyHeader === true && 'sticky top-0 z-(--z-sticky)',
        )}
      >
        <tr>
          {selection !== undefined && (
            <th className={cn(thBase, 'w-8')}>
              <Checkbox
                checked={selState === 'all' ? true : selState === 'some' ? 'indeterminate' : false}
                aria-label={t('table.selectAll')}
                onCheckedChange={() => selection.onToggleAll(visibleIds, selState !== 'all')}
              />
            </th>
          )}
          {columns.map((col) => {
            const sorted = ariaSort(col);
            return (
              <th
                key={col.key}
                className={cn(
                  thBase,
                  col.align === 'right' ? 'text-right' : 'text-left',
                  col.hideBelow !== undefined && HIDE_BELOW[col.hideBelow],
                )}
                {...(col.width !== undefined ? { style: { width: col.width } } : {})}
                {...(sorted !== undefined ? { 'aria-sort': sorted } : {})}
              >
                {headerCell(col)}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {isLoading
          ? skeletonRows
          : rows.map((row) => {
              const id = rowKey(row);
              return (
                <tr
                  key={id}
                  className={cn(
                    'hover:bg-surface-2/60',
                    onRowClick !== undefined && 'cursor-pointer',
                  )}
                  {...(onRowClick !== undefined
                    ? {
                        tabIndex: 0,
                        onClick: () => onRowClick(row),
                        onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => onRowKeyDown(e, row),
                      }
                    : {})}
                >
                  {selection !== undefined && (
                    <td
                      className={cn(tdBase, rowH, 'w-8')}
                      onClick={(e: MouseEvent<HTMLTableCellElement>) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={selection.selected.includes(id)}
                        aria-label={t('table.selectRow')}
                        onCheckedChange={() => selection.onToggleRow(id)}
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        tdBase,
                        rowH,
                        col.align === 'right' && 'text-right',
                        col.hideBelow !== undefined && HIDE_BELOW[col.hideBelow],
                      )}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
      </tbody>
    </table>
  );

  let pager: ReactNode = null;
  if (pagination !== undefined) {
    const { page, pageSize, total, hasNext, onPageChange } = pagination;
    const label =
      total !== undefined
        ? t('table.range', { ...pageRange(page, pageSize, total), total })
        : t('table.page', { page });
    const prevDisabled = page <= 1;
    const nextDisabled =
      total !== undefined ? page * pageSize >= total : hasNext !== undefined ? !hasNext : true;
    pager = (
      <div className="flex items-center justify-between gap-2 py-2 text-xs text-text-secondary">
        <span>{label}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={ICON_BTN}
            aria-label={t('common.prevPage')}
            disabled={prevDisabled}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={ICON_BTN}
            aria-label={t('common.nextPage')}
            disabled={nextDisabled}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {mobileCard !== undefined && (
        <ul className="flex flex-col gap-2 md:hidden">
          {isLoading
            ? Array.from({ length: loadingRows }, (_, i) => (
                <li key={`skeleton-card-${i}`}>
                  <Skeleton className="h-20 w-full rounded-lg" />
                </li>
              ))
            : rows.map((row) => <li key={rowKey(row)}>{mobileCard(row)}</li>)}
        </ul>
      )}
      <div className={cn('overflow-x-auto', mobileCard !== undefined && 'hidden md:block')}>
        {table}
      </div>
      {pager}
    </div>
  );
}
