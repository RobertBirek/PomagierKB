/**
 * Plakietki i etykiety słownikowe Inboxu na kicie v2 (Badge) — statusy draftów
 * (withdrawn spoza lib/status.ts), statusy luk i źródła treści.
 */
import { Badge } from '@/ui/badge';
import { statusLabel, statusVariant } from '@/lib/status';
import { t } from '@/i18n/t';

/** Status szkicu → Badge (withdrawn ma własną etykietę PL spoza lib/status). */
export function draftStatusBadge(status: string) {
  if (status === 'withdrawn') return <Badge variant="neutral">{t('inbox.status.withdrawn')}</Badge>;
  return <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>;
}

/** Status luki wiedzy → Badge (słownik luk spoza lib/status). */
export function gapStatusBadge(status: string) {
  switch (status) {
    case 'open':
      return <Badge variant="warn">{t('inbox.gaps.status.open')}</Badge>;
    case 'in_draft':
      return <Badge variant="accent">{t('inbox.gaps.status.in_draft')}</Badge>;
    case 'resolved':
      return <Badge variant="ok">{t('inbox.gaps.status.resolved')}</Badge>;
    case 'ignored':
      return <Badge variant="neutral">{t('inbox.gaps.status.ignored')}</Badge>;
    default:
      return <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>;
  }
}

export function sourceLabel(sourceType: string | null): string {
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

export function gapSourceLabel(source: string): string {
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
