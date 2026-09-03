import { describe, expect, it } from 'vitest';
import {
  documentTitle,
  mobileItems,
  navItemForPathname,
  pageTitle,
  pendingDraftsFromStatus,
  visibleItems,
  visibleSections,
} from '../src/components/shell/nav';

const paths = (sections: ReturnType<typeof visibleSections>) =>
  sections.map((s) => ({ section: s.labelKey, items: s.items.map((i) => i.path) }));

describe('visibleSections()', () => {
  it('viewer: overview/ask/add (perm ask+propose); bez inbox/kb/mcp/settings', () => {
    expect(paths(visibleSections('viewer'))).toEqual([
      { section: 'nav.section.work', items: ['/overview', '/ask', '/add'] },
    ]);
  });

  it('operator: + inbox i kb; bez mcp/settings (puste sekcje znikają)', () => {
    expect(paths(visibleSections('operator'))).toEqual([
      { section: 'nav.section.work', items: ['/overview', '/ask', '/add', '/inbox'] },
      { section: 'nav.section.resources', items: ['/kb'] },
    ]);
  });

  it('admin: wszystkie sekcje i pozycje', () => {
    expect(paths(visibleSections('admin'))).toEqual([
      { section: 'nav.section.work', items: ['/overview', '/ask', '/add', '/inbox'] },
      { section: 'nav.section.resources', items: ['/kb', '/mcp'] },
      { section: 'nav.section.system', items: ['/settings'] },
    ]);
  });

  it('brak roli (fail-closed) → pusto', () => {
    expect(visibleSections(null)).toEqual([]);
    expect(visibleSections(undefined)).toEqual([]);
  });

  it('badge pendingDrafts wisi przy /inbox', () => {
    const inbox = visibleItems('admin').find((i) => i.path === '/inbox');
    expect(inbox?.badge).toBe('pendingDrafts');
  });
});

describe('mobileItems()', () => {
  it('viewer: ask/add bez „Więcej" (plan roli go nie przewiduje)', () => {
    const plan = mobileItems('viewer');
    expect(plan.items.map((i) => i.path)).toEqual(['/ask', '/add']);
    expect(plan.more).toBe(false);
  });

  it('operator: ask/add/inbox/kb + Więcej', () => {
    const plan = mobileItems('operator');
    expect(plan.items.map((i) => i.path)).toEqual(['/ask', '/add', '/inbox', '/kb']);
    expect(plan.more).toBe(true);
  });

  it('admin: ask/inbox/kb/mcp + Więcej', () => {
    const plan = mobileItems('admin');
    expect(plan.items.map((i) => i.path)).toEqual(['/ask', '/inbox', '/kb', '/mcp']);
    expect(plan.more).toBe(true);
  });

  it('brak roli → pusto (fail-closed)', () => {
    expect(mobileItems(undefined)).toEqual({ items: [], more: false });
  });
});

describe('tytuły tras', () => {
  it('pageTitle: mapa nav → PL, pod-trasy dziedziczą po sekcji', () => {
    expect(pageTitle('/ask')).toBe('Zapytaj');
    expect(pageTitle('/overview')).toBe('Przegląd');
    expect(pageTitle('/settings')).toBe('Ustawienia');
    expect(pageTitle('/kb/some-sub-path')).toBe('Bazy wiedzy');
    expect(pageTitle('/nope')).toBeUndefined();
  });

  it('documentTitle: "<Strona> — PomagierKB"; nieznana trasa → sam brand', () => {
    expect(documentTitle('/ask')).toBe('Zapytaj — PomagierKB');
    expect(documentTitle('/inbox')).toBe('Inbox — PomagierKB');
    expect(documentTitle('/mcp')).toBe('MCP — PomagierKB');
    expect(documentTitle('/unknown')).toBe('PomagierKB');
  });

  it('navItemForPathname: dopasowanie po pierwszym segmencie', () => {
    expect(navItemForPathname('/inbox')?.path).toBe('/inbox');
    expect(navItemForPathname('/inbox/123')?.path).toBe('/inbox');
    expect(navItemForPathname('/')).toBeUndefined();
  });
});

describe('pendingDraftsFromStatus()', () => {
  it('parsuje liczbę z detail sondy inbox ("oczekujące: N")', () => {
    expect(pendingDraftsFromStatus([{ id: 'inbox', detail: 'oczekujące: 3' }])).toBe(3);
    expect(pendingDraftsFromStatus([{ id: 'db', detail: 'quick_check: ok' }, { id: 'inbox', detail: 'oczekujące: 0' }])).toBe(0);
  });

  it('brak sygnału / brak liczby / brak danych → undefined (badge znika)', () => {
    expect(pendingDraftsFromStatus(undefined)).toBeUndefined();
    expect(pendingDraftsFromStatus([])).toBeUndefined();
    expect(pendingDraftsFromStatus([{ id: 'inbox' }])).toBeUndefined();
    expect(pendingDraftsFromStatus([{ id: 'inbox', detail: 'timeout sondy' }])).toBeUndefined();
  });

  it('preferuje pole liczbowe pendingDrafts z sondy inbox (detail tylko fallback)', () => {
    expect(pendingDraftsFromStatus([{ id: 'inbox', pendingDrafts: 5 }])).toBe(5);
    expect(pendingDraftsFromStatus([{ id: 'inbox', pendingDrafts: 0, detail: 'oczekujące: 3' }])).toBe(0);
    expect(pendingDraftsFromStatus([{ id: 'inbox', pendingDrafts: 5, detail: 'oczekujące: 3' }])).toBe(5);
  });

  it('niepoprawne pendingDrafts (NaN/ujemne/ułamek) → fallback na detail', () => {
    expect(pendingDraftsFromStatus([{ id: 'inbox', pendingDrafts: Number.NaN, detail: 'oczekujące: 2' }])).toBe(2);
    expect(pendingDraftsFromStatus([{ id: 'inbox', pendingDrafts: -1, detail: 'oczekujące: 2' }])).toBe(2);
    expect(pendingDraftsFromStatus([{ id: 'inbox', pendingDrafts: 1.5 }])).toBeUndefined();
  });
});
