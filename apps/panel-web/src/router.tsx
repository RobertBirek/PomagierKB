/**
 * TanStack Router — konfiguracja CODE-BASED (jeden plik tras, bez plugina).
 * KONWENCJA DLA AGENTÓW STRON: trasa już istnieje i wskazuje na
 * src/routes/<Nazwa>Page.tsx — podmieniaj ZAWARTOŚĆ pliku strony, nie router.
 * Nowe pod-trasy / search-params dopisuj przy swojej trasie poniżej.
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { RootLayout } from './components/RootLayout';
import { parseAddSearch } from './lib/prefill';
import { AskPage } from './routes/AskPage';
import { AddPage } from './routes/AddPage';
import { InboxPage } from './routes/InboxPage';
import { KbPage } from './routes/KbPage';
import { McpPage } from './routes/McpPage';
import { SettingsPage } from './routes/SettingsPage';

const rootRoute = createRootRoute({ component: RootLayout });

/** Indeks → /ask (jedyna strona dostępna dla każdego zalogowanego). */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/ask' });
  },
});

const askRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ask',
  component: AskPage,
});

/** Search-params /add: ?question= — prefill z luki wiedzy albo z /ask (nie-wiem). */
export interface AddSearch {
  question?: string;
}

const addRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/add',
  validateSearch: (search: Record<string, unknown>): AddSearch => parseAddSearch(search),
  component: AddPage,
});

/** Typowane search-params Inboxu — deep-linki filtrów (?tab=gaps&status=pending&kb=X&q=...&page=2). */
export interface InboxSearch {
  /** Zakładka: 'drafts' (domyślna, nie serializowana) | 'gaps'. */
  tab?: 'gaps';
  status?: string;
  kb?: string;
  q?: string;
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
    if (status !== undefined) out.status = status;
    if (kb !== undefined) out.kb = kb;
    if (q !== undefined) out.q = q;
    const page = Number(search['page']);
    if (Number.isInteger(page) && page > 1) out.page = page;
    return out;
  },
  component: InboxPage,
});

const kbRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kb',
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
  component: McpPage,
});

/** Zakładki /settings — deep-link (?tab=system). Default (llm) bez parametru. */
export type SettingsTab = 'llm' | 'thresholds' | 'system' | 'diag';
const SETTINGS_TABS: readonly SettingsTab[] = ['llm', 'thresholds', 'system', 'diag'];
export interface SettingsSearch {
  tab?: SettingsTab;
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (search: Record<string, unknown>): SettingsSearch => {
    const tab = search['tab'];
    if (typeof tab === 'string' && tab !== 'llm' && (SETTINGS_TABS as readonly string[]).includes(tab)) {
      return { tab: tab as SettingsTab };
    }
    return {};
  },
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
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
