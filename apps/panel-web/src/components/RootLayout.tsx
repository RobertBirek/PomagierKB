/**
 * APP SHELL v2 (Linear-like): Sidebar (desktop) + Topbar + MobileNav (<768px).
 * Nawigacja WYŁĄCZNIE po stronach dozwolonych dla roli (can() przez rejestr
 * shell/nav.ts); gating bieżącej ścieżki to UX — egzekwuje backend.
 * Brak sesji → apiFetch w useMe robi redirect na /auth/login.
 */
import { HeadContent, Outlet, useRouterState } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { TooltipProvider } from '@/ui/tooltip';
import { useMe } from '@/hooks/useMe';
import { can, PAGE_PERMISSION } from '@/lib/permissions';
import { t } from '@/i18n/t';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';
import { Sidebar, useSidebarCollapsed } from './shell/Sidebar';
import { Topbar } from './shell/Topbar';
import { MobileNav } from './shell/MobileNav';

/** Szkielet shellu (pending) i rama stanu błędu — wspólna konstrukcja. */
function ShellFrame({ children, busy }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[auto_1fr]">
      <div className="hidden w-60 border-r border-border bg-surface md:block" aria-hidden="true">
        <div className="flex h-12 items-center gap-2 px-3">
          <span className="flex size-5 items-center justify-center rounded-md bg-accent text-2xs font-semibold text-on-accent">
            P
          </span>
          <span className="text-sm font-semibold">PomagierKB</span>
        </div>
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="h-12 border-b border-border bg-bg/80" />
        <main className="flex flex-col gap-4 px-4 py-5 md:px-6" {...(busy === true ? { 'aria-busy': true } : {})}>
          {children}
        </main>
      </div>
    </div>
  );
}

export function RootLayout() {
  const me = useMe();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [collapsed, toggleSidebar] = useSidebarCollapsed();

  if (me.isPending) {
    return (
      <>
        <HeadContent />
        <ShellFrame busy>
          <Skeleton height="40px" />
          <Skeleton height="180px" />
        </ShellFrame>
      </>
    );
  }

  if (me.isError || me.data === undefined) {
    return (
      <>
        <HeadContent />
        <ShellFrame>
          <EmptyState
            icon="🔌"
            title={t('common.error')}
            description={t('error.network')}
            action={
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-hover"
                onClick={() => void me.refetch()}
              >
                {t('common.retry')}
              </button>
            }
          />
        </ShellFrame>
      </>
    );
  }

  const role = me.data.user.role;

  // Gating bieżącej ścieżki (UX — egzekwuje backend): strona spoza roli → komunikat.
  const section = '/' + (pathname.split('/')[1] ?? '');
  const sectionPerm = PAGE_PERMISSION[section];
  const forbidden = sectionPerm !== undefined && !can(role, sectionPerm);

  return (
    <TooltipProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-(--z-toast) focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
      >
        {t('shell.skipToContent')}
      </a>
      <HeadContent />
      <div className="min-h-dvh md:grid md:grid-cols-[auto_1fr]">
        <Sidebar role={role} collapsed={collapsed} />
        <div className="flex min-w-0 flex-col">
          <Topbar displayName={me.data.user.displayName} role={role} onToggleSidebar={toggleSidebar} />
          <main id="main" tabIndex={-1} className="px-4 py-5 pb-24 md:px-6 md:pb-8">
            {forbidden ? (
              <EmptyState icon={<Lock size={32} aria-hidden="true" />} title={t('error.forbidden')} />
            ) : (
              <Outlet />
            )}
          </main>
        </div>
      </div>
      <MobileNav role={role} />
    </TooltipProvider>
  );
}
