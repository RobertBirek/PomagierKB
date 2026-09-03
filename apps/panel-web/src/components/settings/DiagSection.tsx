/**
 * Zakładka Diagnostyka (/settings) — bez zmian funkcjonalnych względem legacy:
 * link do kontraktu OpenAPI + wersje (React/tryb builda/sesja) w CodeBlock inline.
 */
import { version as reactVersion } from 'react';
import { ExternalLink } from 'lucide-react';
import { useMe } from '@/hooks/useMe';
import { t, formatDateTime } from '@/i18n/t';
import { Card, CardBody, CardDescription, CardTitle } from '@/ui/card';
import { CodeBlock } from '@/ui/code-block';

export function DiagSection() {
  const me = useMe();
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardBody className="flex flex-col gap-2">
          <CardTitle className="text-base">{t('settings.diag.openapiTitle')}</CardTitle>
          <CardDescription>{t('settings.diag.openapiDesc')}</CardDescription>
          <div>
            <a
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-text shadow-xs transition-colors hover:bg-surface-2"
              href="/openapi.json"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('settings.diag.openapiLink')}
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardBody className="flex flex-col gap-2">
          <CardTitle className="text-base">{t('settings.diag.versionsTitle')}</CardTitle>
          <CodeBlock inline copyable={false} code={t('settings.diag.react', { version: reactVersion })} />
          <CodeBlock
            inline
            copyable={false}
            code={t('settings.diag.mode', {
              mode: import.meta.env.PROD ? t('settings.diag.modeProd') : t('settings.diag.modeDev'),
            })}
          />
          {me.data !== undefined && (
            <p className="text-xs text-text-secondary">
              {t('settings.diag.session', { at: formatDateTime(me.data.session.expiresAt) })}
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
