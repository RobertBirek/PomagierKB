/**
 * /overview „Przegląd" v2 (Faza 3, kit ui/): kafle metryk (KB, dokumenty,
 * szkice pending, otwarte luki, nieudane akcje — deep-linki filtrowane rolą),
 * health cockpit inline (buildHealthCockpit + useStatus), lista 5 ostatnich
 * akcji, szybkie akcje. Błąd JEDNEGO źródła ≠ wywrotka strony — kafel pokazuje
 * „—" z Tooltipem; sekcje ładują się niezależnie (Skeleton per sekcja).
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  AlertTriangle,
  Database,
  FileText,
  Inbox,
  KeyRound,
  Lightbulb,
  MessageSquare,
  PlusCircle,
  RefreshCw,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiFetch, apiFetchWithMeta } from '../lib/api';
import { buildHealthCockpit, type HealthSignal } from '../lib/health';
import { healthVariant, statusLabel, statusVariant } from '../lib/status';
import {
  actionTypeLabelKey,
  computeKbStats,
  metaTotal,
  openGapsCount,
} from '../lib/overviewMetrics';
import { can } from '../lib/permissions';
import { useMe } from '../hooks/useMe';
import { useStatus } from '../hooks/useStatus';
import { pl, type PlKey } from '../i18n/pl';
import { t, formatDateTime, formatNumber } from '../i18n/t';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { buttonVariants, IconButton } from '@/ui/button';
import { Card, CardBody, CardHeader } from '@/ui/card';
import { cn } from '@/ui/cn';
import { MetricTile } from '@/ui/metric-tile';
import { PageContainer } from '@/ui/page-container';
import { PageHeader } from '@/ui/page-header';
import { Skeleton, SkeletonText } from '@/ui/skeleton';
import { Tooltip } from '@/ui/tooltip';

// ── typy odpowiedzi API (services/kb.ts, routes/actions.ts) ──────────────────

interface KbListItem {
  namespace: string;
  status: string;
  totals?: { documents?: number; chunks?: number } | null;
}

interface ActionListItem {
  id: string;
  type: string;
  resource: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

interface GapStatsDto {
  stats: Record<string, number>;
  total: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Kafel metryki z obsługą błędu źródła (— + Tooltip) ───────────────────────

interface TileProps {
  label: string;
  icon: LucideIcon;
  hint?: string;
  loading: boolean;
  value: number | null;
  /** Komunikat błędu źródła — kafel pokazuje „—" z Tooltipem. */
  error?: string;
  onClick: () => void;
}

function OverviewTile({ label, icon, hint, loading, value, error, onClick }: TileProps) {
  if (loading) {
    return <Skeleton className="h-[104px]" />;
  }
  if (value === null) {
    return (
      <Tooltip content={t('overview.tile.error', { message: error ?? t('common.error') })}>
        <span className="block" tabIndex={0}>
          <MetricTile label={label} icon={icon} value="—" {...(hint !== undefined ? { hint } : {})} />
        </span>
      </Tooltip>
    );
  }
  return (
    <MetricTile
      label={label}
      icon={icon}
      value={formatNumber(value)}
      {...(hint !== undefined ? { hint } : {})}
      onClick={onClick}
    />
  );
}

/** Etykieta sygnału cockpitu: klucz 'health.signal.*' → t(), inaczej gotowy tekst z API. */
function signalLabel(signal: HealthSignal): string {
  return signal.label in pl ? t(signal.label as PlKey) : signal.label;
}

// ── Strona ───────────────────────────────────────────────────────────────────

export function OverviewPage() {
  const me = useMe();
  const navigate = useNavigate();
  const role = me.data?.user.role;
  const canInbox = can(role, 'inbox');
  const canGaps = can(role, 'gaps');
  const canSettings = can(role, 'settings');

  const status = useStatus();
  const kbs = useQuery({
    queryKey: ['kbs'],
    queryFn: () => apiFetch<{ items: KbListItem[] }>('/api/v1/kbs'),
  });
  const drafts = useQuery({
    queryKey: ['overview', 'drafts-pending'],
    enabled: canInbox,
    queryFn: () => apiFetchWithMeta<{ items: unknown[] }>('/api/v1/drafts?status=pending&limit=1'),
  });
  const gaps = useQuery({
    queryKey: ['overview', 'gap-stats'],
    enabled: canGaps,
    queryFn: () => apiFetch<GapStatsDto>('/api/v1/learning/stats'),
  });
  const failed = useQuery({
    queryKey: ['overview', 'actions-failed'],
    enabled: canSettings,
    queryFn: () => apiFetchWithMeta<{ items: unknown[] }>('/api/v1/actions?status=error&limit=1'),
  });
  const quality = useQuery({
    queryKey: ['learning-quality'],
    queryFn: () =>
      apiFetch<{ report: { verdict: 'OK' | 'WARN' | 'FAIL'; createdAt: string; checks: { details?: Record<string, unknown> }[] } | null }>(
        '/api/v1/learning/quality',
      ),
    staleTime: 60_000,
  });

  const recent = useQuery({
    queryKey: ['overview', 'actions-recent'],
    enabled: canInbox,
    queryFn: () => apiFetch<{ items: ActionListItem[] }>('/api/v1/actions?limit=5'),
  });

  function refreshAll(): void {
    void status.refetch();
    void kbs.refetch();
    if (canInbox) {
      void drafts.refetch();
      void recent.refetch();
    }
    if (canGaps) void gaps.refetch();
    if (canSettings) void failed.refetch();
  }

  const kbStats = computeKbStats(kbs.data?.items);
  const cockpit =
    status.data !== undefined
      ? buildHealthCockpit({ components: status.data.components, breakers: status.data.breakers })
      : null;
  const openBreakers =
    status.data?.breakers.filter((b) => b.state.toLowerCase() !== 'closed') ?? [];

  const generatedAt = status.data?.generatedAt;

  return (
    <PageContainer width="settings">
      <PageHeader
        title={t('overview.title')}
        {...(generatedAt !== undefined
          ? { description: t('overview.generatedAt', { at: formatDateTime(generatedAt) }) }
          : {})}
        actions={
          <IconButton
            aria-label={t('overview.refresh')}
            variant="secondary"
            loading={status.isFetching}
            onClick={refreshAll}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </IconButton>
        }
      />

      <div className="flex flex-col gap-5">
        {/* Kafle metryk (filtrowane rolą) */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <OverviewTile
            label={t('overview.tile.kbs')}
            icon={Database}
            loading={kbs.isLoading}
            value={kbs.isError ? null : kbStats.active}
            {...(kbs.isError
              ? { error: errorMessage(kbs.error) }
              : { hint: t('overview.tile.kbsHint', { active: kbStats.active, total: kbStats.total }) })}
            onClick={() => void navigate({ to: '/kb' })}
          />
          <OverviewTile
            label={t('overview.tile.docs')}
            icon={FileText}
            loading={kbs.isLoading}
            value={kbs.isError ? null : kbStats.documents}
            {...(kbs.isError
              ? { error: errorMessage(kbs.error) }
              : { hint: t('overview.tile.docsHint', { chunks: formatNumber(kbStats.chunks) }) })}
            onClick={() => void navigate({ to: '/kb' })}
          />
          {canInbox && (
            <OverviewTile
              label={t('overview.tile.drafts')}
              icon={Inbox}
              hint={t('overview.tile.draftsHint')}
              loading={drafts.isLoading}
              value={drafts.isError ? null : metaTotal(drafts.data?.meta)}
              {...(drafts.isError ? { error: errorMessage(drafts.error) } : {})}
              onClick={() => void navigate({ to: '/inbox', search: { status: 'pending' } })}
            />
          )}
          {canGaps && (
            <OverviewTile
              label={t('overview.tile.gaps')}
              icon={Lightbulb}
              hint={t('overview.tile.gapsHint')}
              loading={gaps.isLoading}
              value={gaps.isError ? null : openGapsCount(gaps.data)}
              {...(gaps.isError ? { error: errorMessage(gaps.error) } : {})}
              onClick={() => void navigate({ to: '/inbox', search: { tab: 'gaps' } })}
            />
          )}
          {canSettings && (
            <OverviewTile
              label={t('overview.tile.failedActions')}
              icon={AlertTriangle}
              hint={t('overview.tile.failedHint')}
              loading={failed.isLoading}
              value={failed.isError ? null : metaTotal(failed.data?.meta)}
              {...(failed.isError ? { error: errorMessage(failed.error) } : {})}
              onClick={() => void navigate({ to: '/settings', search: { tab: 'system', status: 'error' } })}
            />
          )}
        </div>

        {/* Health cockpit inline */}
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold text-text">{t('overview.health.title')}</h2>
            {cockpit !== null && (
              <Badge variant={healthVariant(cockpit.overallStatus)} dot>
                {statusLabel(cockpit.overallStatus)}
              </Badge>
            )}
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            {cockpit === null ? (
              <SkeletonText lines={3} />
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
                {cockpit.signals.map((signal) => (
                  <div key={signal.id} className="flex min-w-0 items-center gap-2">
                    <Badge variant={healthVariant(signal.status)} dot>
                      {statusLabel(signal.status)}
                    </Badge>
                    <span className="truncate text-sm text-text">{signalLabel(signal)}</span>
                    {signal.value !== '' && (
                      <span className="truncate text-xs text-text-tertiary">{signal.value}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {openBreakers.length > 0 && (
              <Alert variant="warn" title={t('overview.health.breakersWarn')}>
                {canSettings ? (
                  <Link to="/settings" search={{ tab: 'health' }} className="text-accent hover:underline">
                    {t('overview.health.breakersLink')}
                  </Link>
                ) : (
                  openBreakers.map((b) => b.name).join(', ')
                )}
              </Alert>
            )}
          </CardBody>
        </Card>

        {/* Ostatnie akcje (operator/admin) — PROSTA lista, wiersz → /settings?tab=system */}
        {canInbox && (
          <Card>
            <CardHeader>
              <h2 className="text-base font-semibold text-text">{t('overview.recent.title')}</h2>
            </CardHeader>
            <CardBody className="p-0">
              {recent.isLoading ? (
                <div className="p-4">
                  <SkeletonText lines={4} />
                </div>
              ) : recent.isError ? (
                <div className="p-4">
                  <Alert variant="warn">{t('overview.recent.error')}</Alert>
                </div>
              ) : (recent.data?.items.length ?? 0) === 0 ? (
                <p className="p-4 text-sm text-text-secondary">{t('overview.recent.empty')}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {recent.data?.items.map((action) => {
                    const typeKey = actionTypeLabelKey(action.type);
                    const row = (
                      <>
                        <span className="min-w-0 grow truncate text-sm text-text">
                          {typeKey !== null ? t(typeKey) : action.type}
                          {action.resource !== null && (
                            <span className="ml-2 text-xs text-text-tertiary">{action.resource}</span>
                          )}
                        </span>
                        <Badge variant={statusVariant(action.status)}>{statusLabel(action.status)}</Badge>
                        <span className="shrink-0 text-xs tabular-nums text-text-tertiary">
                          {formatDateTime(action.startedAt)}
                        </span>
                      </>
                    );
                    return (
                      <li key={action.id}>
                        {canSettings ? (
                          <Link
                            to="/settings"
                            search={{ tab: 'system' }}
                            aria-label={t('overview.recent.openSystem', { id: action.id })}
                            className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
                          >
                            {row}
                          </Link>
                        ) : (
                          <div className="flex items-center gap-3 px-4 py-2.5">{row}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>
        )}

        {/* Jakość odpowiedzi — ostatni tygodniowy raport quality_answers */}
        {quality.data?.report != null && (
          <Card>
            <CardHeader className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-text">{t('overview.quality.title')}</h2>
              <Badge
                variant={
                  quality.data.report.verdict === 'OK'
                    ? 'ok'
                    : quality.data.report.verdict === 'WARN'
                      ? 'warn'
                      : 'fail'
                }
              >
                {quality.data.report.verdict}
              </Badge>
            </CardHeader>
            <CardBody className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-secondary">
              {(() => {
                const d = quality.data.report.checks[0]?.details as
                  | { answers?: number; noAnswerRate?: number | null; feedback?: { downRate?: number | null }; openGaps?: number }
                  | undefined;
                if (d === undefined) return null;
                return (
                  <>
                    <span>{t('overview.quality.answers', { n: d.answers ?? 0 })}</span>
                    {d.noAnswerRate != null && (
                      <span>{t('overview.quality.noAnswer', { pct: Math.round(d.noAnswerRate * 100) })}</span>
                    )}
                    {d.feedback?.downRate != null && (
                      <span>{t('overview.quality.down', { pct: Math.round(d.feedback.downRate * 100) })}</span>
                    )}
                    {d.openGaps !== undefined && <span>{t('overview.quality.gaps', { n: d.openGaps })}</span>}
                    <span className="basis-full text-xs text-text-tertiary">
                      {t('overview.quality.asOf', { date: new Date(quality.data.report.createdAt).toLocaleString('pl-PL') })}
                    </span>
                  </>
                );
              })()}
            </CardBody>
          </Card>
        )}

        {/* Szybkie akcje wg roli */}
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold text-text">{t('overview.quick.title')}</h2>
          </CardHeader>
          <CardBody className="flex flex-wrap gap-2">
            <Link to="/ask" className={cn(buttonVariants({ variant: 'secondary' }))}>
              <MessageSquare size={16} aria-hidden="true" />
              {t('overview.quick.ask')}
            </Link>
            {can(role, 'propose') && (
              <Link to="/add" className={cn(buttonVariants({ variant: 'secondary' }))}>
                <PlusCircle size={16} aria-hidden="true" />
                {t('overview.quick.add')}
              </Link>
            )}
            {can(role, 'kb-create') && (
              <Link to="/kb" className={cn(buttonVariants({ variant: 'secondary' }))}>
                <Database size={16} aria-hidden="true" />
                {t('overview.quick.newKb')}
              </Link>
            )}
            {can(role, 'mcp') && (
              <Link to="/mcp" className={cn(buttonVariants({ variant: 'secondary' }))}>
                <KeyRound size={16} aria-hidden="true" />
                {t('overview.quick.newKey')}
              </Link>
            )}
          </CardBody>
        </Card>
      </div>
    </PageContainer>
  );
}
