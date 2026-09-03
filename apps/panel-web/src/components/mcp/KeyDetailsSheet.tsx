/**
 * Sheet szczegółów klucza API (klik wiersza tabeli): zakres, profil,
 * właściciel, ostatnie użycie, liczba żądań, utworzony/przez, wygasanie.
 */
import { t, formatDateTime, formatNumber } from '@/i18n/t';
import { keyBadgeInfo } from '@/lib/mcp';
import { Badge } from '@/ui/badge';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import type { ApiKeyView } from './types';

export function KeyDetailsSheet({
  apiKey,
  ownerName,
  onClose,
}: {
  apiKey: ApiKeyView | null;
  ownerName: (userId: string) => string;
  onClose: () => void;
}) {
  const info = apiKey !== null ? keyBadgeInfo(apiKey.status, apiKey.expiresAt, Date.now()) : null;
  return (
    <Sheet open={apiKey !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" size="md">
        <SheetHeader>
          <SheetTitle>{apiKey?.label ?? t('mcp.keys.detailsTitle')}</SheetTitle>
          <SheetDescription>
            <code className="font-mono text-xs">{apiKey !== null ? `${apiKey.prefix}…` : ''}</code>
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4">
          {apiKey !== null && info !== null && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={info.variant} dot>
                  {t(info.labelKey)}
                </Badge>
                {info.days !== null && info.days > 0 && (
                  <span className="text-xs text-text-secondary">
                    {t('mcp.keys.daysLeft', { days: info.days })}
                  </span>
                )}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-text-secondary">{t('mcp.keys.owner')}</dt>
                <dd className="text-text">{ownerName(apiKey.userId)}</dd>
                <dt className="text-text-secondary">{t('mcp.keys.profile')}</dt>
                <dd>
                  <code className="font-mono text-xs">{apiKey.profileId}</code>
                </dd>
                <dt className="text-text-secondary">{t('mcp.keys.scope')}</dt>
                <dd className="text-text">{apiKey.scopes.join(', ')}</dd>
                <dt className="text-text-secondary">{t('mcp.keys.expires')}</dt>
                <dd className="text-text">{formatDateTime(apiKey.expiresAt)}</dd>
                <dt className="text-text-secondary">{t('mcp.keys.lastUsed')}</dt>
                <dd className="text-text">
                  {apiKey.lastUsedAt !== null ? formatDateTime(apiKey.lastUsedAt) : t('mcp.keys.never')}
                </dd>
                <dt className="text-text-secondary">{t('mcp.keys.requests')}</dt>
                <dd className="text-text tabular-nums">{formatNumber(apiKey.requestsCount)}</dd>
                <dt className="text-text-secondary">{t('mcp.keys.createdAt')}</dt>
                <dd className="text-text">{formatDateTime(apiKey.createdAt)}</dd>
                <dt className="text-text-secondary">{t('mcp.keys.createdBy')}</dt>
                <dd className="text-text">{ownerName(apiKey.createdBy)}</dd>
              </dl>
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
