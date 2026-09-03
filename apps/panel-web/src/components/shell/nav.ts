/**
 * Rejestr nawigacji APP SHELL v2 — JEDYNE źródło prawdy o pozycjach menu
 * (sidebar, mobile nav, command palette, tytuły dokumentu). Czyste funkcje —
 * testy w test/shell-nav.test.ts.
 */
import {
  FilePlus2,
  Inbox,
  LayoutDashboard,
  Library,
  MessageSquare,
  Plug,
  Settings,
  type LucideIcon,
} from 'lucide-react';
// Importy RELATYWNE (nie '@/'): plik jest testowany w vitest (node env),
// a root vitest.config.ts nie konfiguruje aliasu '@'.
import { can, PAGE_PERMISSION, type Role } from '../../lib/permissions';
import { pl, type PlKey } from '../../i18n/pl';

export interface NavItem {
  path: string;
  labelKey: PlKey;
  icon: LucideIcon;
  /** Licznik przy pozycji (obecnie tylko szkice czekające na recenzję). */
  badge?: 'pendingDrafts';
}

export interface NavSection {
  labelKey: PlKey;
  items: readonly NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    labelKey: 'nav.section.work',
    items: [
      { path: '/overview', labelKey: 'nav.overview', icon: LayoutDashboard },
      { path: '/ask', labelKey: 'nav.ask', icon: MessageSquare },
      { path: '/add', labelKey: 'nav.add', icon: FilePlus2 },
      { path: '/inbox', labelKey: 'nav.inbox', icon: Inbox, badge: 'pendingDrafts' },
    ],
  },
  {
    labelKey: 'nav.section.resources',
    items: [
      { path: '/kb', labelKey: 'nav.kb', icon: Library },
      { path: '/mcp', labelKey: 'nav.mcp', icon: Plug },
    ],
  },
  {
    labelKey: 'nav.section.system',
    items: [{ path: '/settings', labelKey: 'nav.settings', icon: Settings }],
  },
];

function itemAllowed(role: Role | null | undefined, item: NavItem): boolean {
  const perm = PAGE_PERMISSION[item.path];
  return perm !== undefined && can(role, perm);
}

/** Sekcje widoczne dla roli — pozycje filtrowane przez can(); puste sekcje znikają. */
export function visibleSections(role: Role | null | undefined): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    labelKey: section.labelKey,
    items: section.items.filter((item) => itemAllowed(role, item)),
  })).filter((section) => section.items.length > 0);
}

/** Płaska lista pozycji widocznych dla roli (command palette, sheet „Więcej"). */
export function visibleItems(role: Role | null | undefined): NavItem[] {
  return visibleSections(role).flatMap((s) => [...s.items]);
}

/**
 * Sloty dolnego paska mobilnego (max 5 z „Więcej"). Kolejność per rola wg
 * projektu shellu: viewer → ask/add; operator → ask/add/inbox/kb + Więcej;
 * admin → ask/inbox/kb/mcp + Więcej. Pozycje i tak przechodzą przez can()
 * (fail-closed przy nieznanej roli).
 */
const MOBILE_PLAN: Record<Role, { slots: readonly string[]; more: boolean }> = {
  viewer: { slots: ['/ask', '/add'], more: false },
  operator: { slots: ['/ask', '/add', '/inbox', '/kb'], more: true },
  admin: { slots: ['/ask', '/inbox', '/kb', '/mcp'], more: true },
};

export interface MobileNavPlan {
  items: NavItem[];
  /** Czy pokazać slot „Więcej" (sheet z pełną nawigacją). */
  more: boolean;
}

export function mobileItems(role: Role | null | undefined): MobileNavPlan {
  if (role === null || role === undefined) return { items: [], more: false };
  const plan = MOBILE_PLAN[role] as { slots: readonly string[]; more: boolean } | undefined;
  if (plan === undefined) return { items: [], more: false };
  const all = new Map(NAV_SECTIONS.flatMap((s) => s.items).map((i) => [i.path, i]));
  const items: NavItem[] = [];
  for (const path of plan.slots) {
    const item = all.get(path);
    if (item !== undefined && itemAllowed(role, item)) items.push(item);
  }
  // „Więcej" tylko, gdy plan roli go przewiduje I faktycznie są dodatkowe pozycje.
  const more = plan.more && visibleItems(role).length > items.length;
  return { items, more };
}

/** Pozycja nav dla ścieżki (dopasowanie po pierwszym segmencie — pod-trasy dziedziczą). */
export function navItemForPathname(pathname: string): NavItem | undefined {
  const section = '/' + (pathname.split('/')[1] ?? '');
  return NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.path === section);
}

/** Tytuł bieżącej strony do topbara (PL); nieznana trasa → undefined. */
export function pageTitle(pathname: string): string | undefined {
  const item = navItemForPathname(pathname);
  return item === undefined ? undefined : pl[item.labelKey];
}

/** Tytuł dokumentu (head/meta): 'Zapytaj — PomagierKB'; nieznana trasa → 'PomagierKB'. */
export function documentTitle(path: string): string {
  const label = pageTitle(path);
  return label === undefined ? 'PomagierKB' : `${label} — PomagierKB`;
}

/**
 * Liczba szkiców czekających na recenzję z GET /api/v1/status.
 * Status nie zwraca czystej liczby — sonda 'inbox' (services/status.ts panel-api)
 * koduje ją w detail: 'oczekujące: N'. Parsujemy defensywnie pierwszą liczbę;
 * brak sygnału / brak liczby → undefined (badge się nie renderuje).
 */
export function pendingDraftsFromStatus(
  components: readonly { id: string; detail?: string | undefined }[] | undefined,
): number | undefined {
  const inbox = components?.find((c) => c.id === 'inbox');
  if (inbox === undefined || inbox.detail === undefined) return undefined;
  const match = /\d+/.exec(inbox.detail);
  if (match === null) return undefined;
  const n = Number(match[0]);
  return Number.isSafeInteger(n) ? n : undefined;
}
