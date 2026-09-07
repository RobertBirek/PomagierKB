/**
 * Strona /backup (admin) — kopie zapasowe i odtwarzanie w jednym miejscu.
 *
 * Zakładki: Stan | Snapshoty | Konfiguracja | Odtwarzanie (URL-sync przez search-param,
 * tak jak /settings). Kontrakt: apps/panel-api/src/routes/backup.ts.
 *
 * Podział ról między panelem a hostem jest tu świadomy i nieprzypadkowy:
 *  - panel WIDZI wszystko (stan hosta publikuje `backup_state.sh`),
 *  - panel USTAWIA to, co niesekretne (retencja, off-site on/off, tryb Neo4j),
 *  - panel WYZWALA bieg najwęższym możliwym kanałem (plik-znacznik + jednostka .path),
 *  - panel NIE ODTWARZA — pokazuje komendy, wykonuje je człowiek na hoście.
 * Uzasadnienie tej ostatniej granicy: `services/backup.ts` w panel-api.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { t, formatDateTime, type PlKey } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { PageContainer } from '@/ui/page-container';
import { PageHeader } from '@/ui/page-header';
import { SkeletonCard } from '@/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { BackupConfigForm } from '@/components/backup/BackupConfigForm';
import { BackupStatusCards } from '@/components/backup/BackupStatusCards';
import { RecoveryGuide, SnapshotsTable } from '@/components/backup/RecoveryGuide';
import type { BackupStateResponse } from '@/components/backup/types';
import type { BackupTab } from '../router';

const TAB_LABEL: Record<BackupTab, PlKey> = {
  state: 'backup.tabs.state',
  snapshots: 'backup.tabs.snapshots',
  config: 'backup.tabs.config',
  recovery: 'backup.tabs.recovery',
};

const BACKUP_TABS: readonly BackupTab[] = ['state', 'snapshots', 'config', 'recovery'];

export function BackupPage() {
  const search = useSearch({ from: '/backup' });
  const navigate = useNavigate();
  const tab: BackupTab = search.tab ?? 'state';

  // Stan pochodzi z pliku odświeżanego przez timer co 10 min — odpytywanie częściej niż
  // co minutę nie dałoby świeższych danych, dałoby tylko ruch.
  const state = useQuery({
    queryKey: ['backup-state'],
    queryFn: () => apiFetch<BackupStateResponse>('/api/v1/backup/state'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <PageContainer>
      <PageHeader
        title={t('backup.title')}
        description={t('backup.subtitle')}
        tabs={
          <TabsList>
            {BACKUP_TABS.map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                onClick={() => void navigate({ to: '/backup', search: value === 'state' ? {} : { tab: value } })}
              >
                {t(TAB_LABEL[value])}
              </TabsTrigger>
            ))}
          </TabsList>
        }
      />

      {state.isPending && <SkeletonCard />}
      {state.isError && (
        <Alert variant="fail" title={t('common.error')}>
          {errorMessage(state.error)}
        </Alert>
      )}

      {state.data !== undefined && (
        <Tabs value={tab}>
          <TabsContent value="state">
            <BackupStatusCards state={state.data} />
          </TabsContent>
          <TabsContent value="snapshots">
            <SnapshotsTable state={state.data} />
          </TabsContent>
          <TabsContent value="config">
            <BackupConfigForm config={state.data.config} />
          </TabsContent>
          <TabsContent value="recovery">
            <RecoveryGuide state={state.data} />
          </TabsContent>
        </Tabs>
      )}

      {state.data?.state?.generatedAt !== null && state.data?.state?.generatedAt !== undefined && (
        <p className="mt-4 text-xs text-text-secondary">
          {t('backup.generatedAt', { when: formatDateTime(state.data.state.generatedAt) })}
        </p>
      )}
    </PageContainer>
  );
}
