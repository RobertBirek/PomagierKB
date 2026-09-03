/**
 * TanStack Router — konfiguracja CODE-BASED (jeden plik tras, bez plugina).
 * KONWENCJA DLA AGENTÓW STRON: trasa już istnieje i wskazuje na
 * src/routes/<Nazwa>Page.tsx — podmieniaj ZAWARTOŚĆ pliku strony, nie router.
 * Nowe pod-trasy / search-params dopisuj przy swojej trasie poniżej.
 * Tytuły dokumentu: head() per trasa (HeadContent renderuje RootLayout).
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { RootLayout } from './components/RootLayout';
import { NotFound } from './components/shell/NotFound';
import { RouteError } from './components/shell/RouteError';
import { documentTitle } from './components/shell/nav';
import { apiFetch } from './lib/api';
import { queryClient } from './lib/queryClient';
import { parseAddSearch } from './lib/prefill';
import type { Me } from './hooks/useMe';
import { OverviewPage } from './routes/OverviewPage';
import { AskPage } from './routes/AskPage';
import { AddPage } from './routes/AddPage';
import { InboxPage } from './routes/InboxPage';
import { KbPage } from './routes/KbPage';
import { McpPage } from './routes/McpPage';
import { SettingsPage } from './routes/SettingsPage';

/** head() trasy — tytuł dokumentu z rejestru nawigacji (shell/nav.ts). */
function routeHead(path: string) {
  return () => ({ meta: [{ title: documentTitle(path) }] });
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

/**
 * Indeks → wg roli: viewer na /ask, operator/admin na /overview.
 * ensureQueryData współdzieli cache ['me'] z useMe; błąd (np. API w restarcie)
 * → bezpieczny fallback /ask (useMe/apiFetch i tak obsłużą sesję).
 */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    let to = '/ask';
    try {
      const me = await queryClient.ensureQueryData({
        queryKey: ['me'],
        queryFn: () => apiFetch<Me>('/api/v1/me'),
        staleTime: 60_000,
      });
      if (me.user.role !== 'viewer') to = '/overview';
    } catch {
      /* fallback: /ask */
    }
    throw redirect({ to });
  },
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/overview',
  head: routeHead('/overview'),
  component: OverviewPage,
});

const askRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ask',
  head: routeHead('/ask'),
  component: AskPage,
});

/**
 * Search-params /add: ?question= — prefill z luki wiedzy albo z /ask (nie-wiem);
 * ?tab=file — zakładka (default 'text' nie jest serializowany).
 */
export interface AddSearch {
  question?: string;
  tab?: 'text' | 'file' | 'url';
}

const addRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/add',
  validateSearch: (search: Record<string, unknown>): AddSearch => {
    const out: AddSearch = parseAddSearch(search);
    if (search['tab'] === 'file') out.tab = 'file';
    if (search['tab'] === 'url') out.tab = 'url';
    return out;
  },
  head: routeHead('/add'),
  component: AddPage,
});

/** Typowane search-params Inboxu — deep-linki filtrów (?tab=gaps&status=pending&kb=X&q=...&page=2). */
export interface InboxSearch {
  /** Zakładka: 'drafts' (domyślna, nie serializowana) | 'gaps'. */
  tab?: 'gaps';
  status?: string;
  kb?: string;
  q?: string;
  /** Filtr tagu draftów (np. 'lesson' — chip Lekcje). */
  tag?: string;
  page?: number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  validateSearch: (search: Record<string, unknown>): InboxSearch => {
    const out: InboxSearch = {};
    if (search['tab'] === 'gaps') out.tab = 'gaps';
    const status = optionalString(search['status']);
    const kb = optionalString(search['kb']);
    const q = optionalString(search['q']);
    const tag = optionalString(search['tag']);
    if (status !== undefined) out.status = status;
    if (kb !== undefined) out.kb = kb;
    if (q !== undefined) out.q = q;
    if (tag !== undefined) out.tag = tag;
    const page = Number(search['page']);
    if (Number.isInteger(page) && page > 1) out.page = page;
    return out;
  },
  head: routeHead('/inbox'),
  component: InboxPage,
});

const kbRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kb',
  head: routeHead('/kb'),
  component: KbPage,
});

/** Zakładki /mcp — deep-link (?tab=profiles). Default (keys) bez parametru. */
export type McpTab = 'keys' | 'profiles' | 'snippets' | 'service' | 'health';
const MCP_TABS: readonly McpTab[] = ['keys', 'profiles', 'snippets', 'service', 'health'];
export interface McpSearch {
  tab?: McpTab;
}

const mcpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mcp',
  validateSearch: (search: Record<string, unknown>): McpSearch => {
    const tab = search['tab'];
    if (typeof tab === 'string' && tab !== 'keys' && (MCP_TABS as readonly string[]).includes(tab)) {
      return { tab: tab as McpTab };
    }
    return {};
  },
  head: routeHead('/mcp'),
  component: McpPage,
});

/**
 * Zakładki /settings — deep-link (?tab=system). Default (llm) bez parametru.
 * Filtry zakładek system/audit (Faza 3): status/type/page (zadania w tle),
 * from/to/action/actor/outcome (audyt) — walidacja łagodna (niepuste stringi).
 */
export type SettingsTab = 'llm' | 'thresholds' | 'system' | 'diag' | 'audit' | 'health';
const SETTINGS_TABS: readonly SettingsTab[] = ['llm', 'thresholds', 'system', 'diag', 'audit', 'health'];
export interface SettingsSearch {
  tab?: SettingsTab;
  status?: string;
  type?: string;
  page?: number;
  from?: string;
  to?: string;
  action?: string;
  actor?: string;
  outcome?: string;
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (search: Record<string, unknown>): SettingsSearch => {
    const out: SettingsSearch = {};
    const tab = search['tab'];
    if (typeof tab === 'string' && tab !== 'llm' && (SETTINGS_TABS as readonly string[]).includes(tab)) {
      out.tab = tab as SettingsTab;
    }
    for (const key of ['status', 'type', 'from', 'to', 'action', 'actor', 'outcome'] as const) {
      const value = optionalString(search[key]);
      if (value !== undefined) out[key] = value;
    }
    const page = Number(search['page']);
    if (Number.isInteger(page) && page > 1) out.page = page;
    return out;
  },
  head: routeHead('/settings'),
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  overviewRoute,
  askRoute,
  addRoute,
  inboxRoute,
  kbRoute,
  mcpRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
