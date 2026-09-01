import { useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { useMe } from '../hooks/useMe';
import { apiFetch } from '../lib/api';
import { can, PAGE_PERMISSION, type Role } from '../lib/permissions';
import { t, type PlKey } from '../i18n/t';
import { ThemeToggle } from './ThemeToggle';
import { HealthIndicator } from './HealthIndicator';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';

/** Pozycje nawigacji — kolejność = kolejność w pasku; filtrowane przez can(). */
const NAV_ITEMS = [
  { path: '/ask', label: 'nav.ask', icon: '💬' },
  { path: '/add', label: 'nav.add', icon: '➕' },
  { path: '/inbox', label: 'nav.inbox', icon: '📥' },
  { path: '/kb', label: 'nav.kb', icon: '📚' },
  { path: '/mcp', label: 'nav.mcp', icon: '🔌' },
  { path: '/settings', label: 'nav.settings', icon: '⚙️' },
] as const satisfies readonly { path: string; label: PlKey; icon: string }[];

const ROLE_LABEL: Record<Role, PlKey> = {
  viewer: 'header.role.viewer',
  operator: 'header.role.operator',
  admin: 'header.role.admin',
};

function UserMenu({ displayName, role }: { displayName: string; role: Role }) {
  const [open, setOpen] = useState(false);
  const logout = useMutation({
    mutationFn: () => apiFetch<{ logoutUrl: string }>('/auth/logout', { method: 'POST' }),
    onSuccess: (data) => window.location.assign(data.logoutUrl),
  });
  return (
    <div className="user-menu">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('header.loggedInAs', { name: displayName })}
        onClick={() => setOpen((v) => !v)}
      >
        👤 <span className="user-menu-name">{displayName}</span>
      </button>
      {open && (
        <div className="user-menu-panel card stack" role="menu">
          <div>
            <strong>{displayName}</strong>
            <div className="muted">{t(ROLE_LABEL[role])}</div>
          </div>
          <button
            type="button"
            className="btn"
            role="menuitem"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            {t('header.logout')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Layout aplikacji: nagłówek (logo, wskaźnik zdrowia, motyw, menu użytkownika),
 * nawigacja WYŁĄCZNIE po stronach dozwolonych dla roli (can()), na mobile dolny
 * pasek. Brak sesji → apiFetch w useMe robi redirect na /auth/login.
 */
export function RootLayout() {
  const me = useMe();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (me.isPending) {
    return (
      <div className="app-shell">
        <header className="app-header">
          <span className="app-logo">PomagierKB</span>
        </header>
        <main className="app-main stack" aria-busy="true">
          <Skeleton height="40px" />
          <Skeleton height="180px" />
        </main>
      </div>
    );
  }

  if (me.isError || me.data === undefined) {
    return (
      <div className="app-shell">
        <header className="app-header">
          <span className="app-logo">PomagierKB</span>
        </header>
        <main className="app-main">
          <EmptyState
            icon="🔌"
            title={t('common.error')}
            description={t('error.network')}
            action={
              <button type="button" className="btn btn-primary" onClick={() => void me.refetch()}>
                {t('common.retry')}
              </button>
            }
          />
        </main>
      </div>
    );
  }

  const role = me.data.user.role;
  const allowed = NAV_ITEMS.filter((item) => {
    const perm = PAGE_PERMISSION[item.path];
    return perm !== undefined && can(role, perm);
  });

  // Gating bieżącej ścieżki (UX — egzekwuje backend): strona spoza roli → komunikat.
  const section = '/' + (pathname.split('/')[1] ?? '');
  const sectionPerm = PAGE_PERMISSION[section];
  const forbidden = sectionPerm !== undefined && !can(role, sectionPerm);

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/ask" className="app-logo">
          PomagierKB
        </Link>
        <nav className="app-nav" aria-label="Nawigacja">
          {allowed.map((item) => (
            <Link key={item.path} to={item.path} activeProps={{ className: 'active' }}>
              {t(item.label)}
            </Link>
          ))}
        </nav>
        <div className="app-header-actions">
          <HealthIndicator />
          <ThemeToggle />
          <UserMenu displayName={me.data.user.displayName} role={role} />
        </div>
      </header>
      <main className="app-main">
        {forbidden ? <EmptyState icon="🔒" title={t('error.forbidden')} /> : <Outlet />}
      </main>
      <nav className="bottom-nav" aria-label="Nawigacja mobilna">
        {allowed.map((item) => (
          <Link key={item.path} to={item.path} activeProps={{ className: 'active' }}>
            <div aria-hidden="true">{item.icon}</div>
            {t(item.label)}
          </Link>
        ))}
      </nav>
    </div>
  );
}
