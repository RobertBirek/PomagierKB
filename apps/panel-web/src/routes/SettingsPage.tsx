/**
 * Strona /settings (admin) — SaaS v2: PageContainer settings + PageHeader
 * z Tabs URL-sync. Zakładki: LLM | Progi | System (akcje) | Audyt | Health |
 * Diagnostyka. Stary deep-link ?tab=system prowadzi do akcji (audyt i health
 * mają własne zakładki). Filtry zakładek System/Audyt żyją w search-params
 * (deep-linki); sekcje w components/settings/*, tabela akcji współdzielona
 * w components/actions/* (Overview linkuje tu deep-linkiem).
 * Kontrakt: apps/panel-api/src/routes/{settings,actions,audit,status}.ts.
 */
import { useNavigate, useSearch } from '@tanstack/react-router';
import { t, type PlKey } from '../i18n/t';
import { PageContainer } from '../ui/page-container';
import { PageHeader } from '../ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ActionsTable, type ActionsFilters } from '../components/actions/ActionsTable';
import { AuditSection, type AuditFilters } from '../components/settings/AuditSection';
import { DiagSection } from '../components/settings/DiagSection';
import { HealthSection } from '../components/settings/HealthSection';
import { LlmSection } from '../components/settings/LlmSection';
import { ThresholdsSection } from '../components/settings/ThresholdsSection';
import type { SettingsSearch, SettingsTab } from '../router';

const TAB_LABEL: Record<SettingsTab, PlKey> = {
  llm: 'settings.tabs.llm',
  thresholds: 'settings.tabs.thresholds',
  system: 'settings.tabs.system',
  audit: 'settings.tabs.audit',
  health: 'settings.tabs.health',
  diag: 'settings.tabs.diag',
};

const SETTINGS_TABS: readonly SettingsTab[] = ['llm', 'thresholds', 'system', 'audit', 'health', 'diag'];

/** Search dla zakładki bez filtrów (default llm nie jest serializowany). */
function searchForTab(tab: SettingsTab): SettingsSearch {
  return tab === 'llm' ? {} : { tab };
}

/** Filtry akcji → search-params (puste wartości i strona 1 wypadają z URL-a). */
function systemSearch(filters: ActionsFilters): SettingsSearch {
  const out: SettingsSearch = { tab: 'system' };
  if (filters.status !== '') out.status = filters.status;
  if (filters.type !== '') out.type = filters.type;
  if (filters.page > 1) out.page = filters.page;
  return out;
}

/** Filtry audytu → search-params. */
function auditSearch(filters: AuditFilters): SettingsSearch {
  const out: SettingsSearch = { tab: 'audit' };
  if (filters.from !== '') out.from = filters.from;
  if (filters.to !== '') out.to = filters.to;
  if (filters.action !== '') out.action = filters.action;
  if (filters.actor !== '') out.actor = filters.actor;
  if (filters.outcome !== '') out.outcome = filters.outcome;
  return out;
}

export function SettingsPage() {
  const search = useSearch({ from: '/settings' });
  const navigate = useNavigate();
  const tab: SettingsTab = search.tab ?? 'llm';

  const actionsFilters: ActionsFilters = {
    status: search.status ?? '',
    type: search.type ?? '',
    page: search.page ?? 1,
  };
  const auditFilters: AuditFilters = {
    from: search.from ?? '',
    to: search.to ?? '',
    action: search.action ?? '',
    actor: search.actor ?? '',
    outcome: search.outcome ?? '',
  };

  function go(next: SettingsSearch): void {
    void navigate({ to: '/settings', search: next, replace: true });
  }

  return (
    <PageContainer width="settings">
      <Tabs
        value={tab}
        onValueChange={(value) => go(searchForTab(value as SettingsTab))}
      >
        <PageHeader
          title={t('nav.settings')}
          description={t('settings.pageDesc')}
          tabs={
            <TabsList className="flex-nowrap overflow-x-auto">
              {SETTINGS_TABS.map((item) => (
                <TabsTrigger key={item} value={item} className="shrink-0">
                  {t(TAB_LABEL[item])}
                </TabsTrigger>
              ))}
            </TabsList>
          }
        />
        <TabsContent value="llm">
          <LlmSection />
        </TabsContent>
        <TabsContent value="thresholds">
          <ThresholdsSection />
        </TabsContent>
        <TabsContent value="system">
          <ActionsTable filters={actionsFilters} onFiltersChange={(next) => go(systemSearch(next))} />
        </TabsContent>
        <TabsContent value="audit">
          <AuditSection filters={auditFilters} onFiltersChange={(next) => go(auditSearch(next))} />
        </TabsContent>
        <TabsContent value="health">
          <HealthSection />
        </TabsContent>
        <TabsContent value="diag">
          <DiagSection />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
