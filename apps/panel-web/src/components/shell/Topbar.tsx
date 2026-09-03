/**
 * Topbar APP SHELL v2: toggle sidebara (przycisk + skrót '['), tytuł strony,
 * przycisk wyszukiwania (⌘K → command palette), health cockpit, menu motywu
 * i menu użytkownika.
 */
import { useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { Check, LogOut, Monitor, Moon, PanelLeft, Search, Sun } from 'lucide-react';
import { Button, IconButton } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Kbd } from '@/ui/kbd';
import { cn } from '@/ui/cn';
import { apiFetch } from '@/lib/api';
import { buildHealthCockpit, type HealthStatus } from '@/lib/health';
import type { Role } from '@/lib/permissions';
import { applyTheme, clearStoredTheme, getStoredTheme, setTheme, type Theme } from '@/lib/theme';
import { useStatus } from '@/hooks/useStatus';
import { t, type PlKey } from '@/i18n/t';
import { pl } from '@/i18n/pl';
import { pageTitle } from './nav';
import { CommandPalette } from './CommandPalette';

/* ── Health cockpit (v2 dawnego components/HealthIndicator.tsx) ── */

const HEALTH_LABEL: Record<HealthStatus, PlKey> = {
  OK: 'header.health.ok',
  WARN: 'header.health.warn',
  FAIL: 'header.health.fail',
  UNKNOWN: 'header.health.unknown',
};

const HEALTH_DOT: Record<HealthStatus, string> = {
  OK: 'bg-ok',
  WARN: 'bg-warn',
  FAIL: 'bg-fail',
  UNKNOWN: 'bg-text-tertiary',
};

/** Etykieta sygnału: klucz pl.ts (sygnały domenowe) LUB gotowy string z API. */
function signalLabel(label: string): string {
  return label in pl ? t(label as PlKey) : label;
}

function HealthMenu() {
  const status = useStatus();
  const cockpit = buildHealthCockpit({
    components: status.data?.components ?? [],
    breakers: status.data?.breakers ?? [],
  });
  const overall: HealthStatus = status.isError ? 'FAIL' : status.isPending ? 'UNKNOWN' : cockpit.overallStatus;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <span className={cn('size-2 shrink-0 rounded-full', HEALTH_DOT[overall])} aria-hidden="true" />
          <span className="hidden sm:inline">{t(HEALTH_LABEL[overall])}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>{t('header.health.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {status.isPending && <div className="px-2 py-1.5 text-sm text-text-tertiary">{t('common.loading')}</div>}
        {status.isError && <div className="px-2 py-1.5 text-sm text-text-tertiary">{t('error.network')}</div>}
        {cockpit.signals.map((signal) => (
          <div key={signal.id} className="flex min-w-56 items-center gap-2.5 px-2 py-1.5 text-sm">
            <span className={cn('size-2 shrink-0 rounded-full', HEALTH_DOT[signal.status])} aria-hidden="true" />
            <span className="truncate text-text">{signalLabel(signal.label)}</span>
            {signal.value !== '' && (
              <span className="ml-auto shrink-0 text-xs text-text-tertiary">{signal.value}</span>
            )}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Menu motywu: light / dark / system ── */

type ThemeMode = Theme | 'system';
const MODE_KEY = 'pomagierkb.theme-mode';

function readThemeMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* localStorage może być zablokowany */
  }
  const stored = getStoredTheme();
  return stored ?? 'system';
}

function persistThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* prywatny tryb */
  }
}

const THEME_OPTIONS: { mode: ThemeMode; labelKey: PlKey; icon: typeof Sun }[] = [
  { mode: 'light', labelKey: 'header.theme.light', icon: Sun },
  { mode: 'dark', labelKey: 'header.theme.dark', icon: Moon },
  { mode: 'system', labelKey: 'header.theme.system', icon: Monitor },
];

function ThemeMenu() {
  const [mode, setMode] = useState<ThemeMode>(readThemeMode);

  // Tryb „system": nasłuch prefers-color-scheme aktualizuje data-theme na żywo.
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyTheme(mq.matches ? 'dark' : 'light');
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode]);

  const select = (next: ThemeMode) => {
    if (next === 'system') {
      clearStoredTheme();
    } else {
      setTheme(next);
    }
    persistThemeMode(next);
    setMode(next);
  };

  const Current = (THEME_OPTIONS.find((o) => o.mode === mode) ?? THEME_OPTIONS[2]!).icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label={t('header.theme.toggle')} size="icon-md">
          <Current size={16} aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {THEME_OPTIONS.map(({ mode: value, labelKey, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => select(value)}>
            <Icon size={16} aria-hidden="true" />
            <span className="grow">{t(labelKey)}</span>
            {mode === value && <Check size={16} aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Menu użytkownika ── */

const ROLE_LABEL: Record<Role, PlKey> = {
  viewer: 'header.role.viewer',
  operator: 'header.role.operator',
  admin: 'header.role.admin',
};

function UserMenu({ displayName, role }: { displayName: string; role: Role }) {
  const logout = useMutation({
    mutationFn: () => apiFetch<{ logoutUrl: string }>('/auth/logout', { method: 'POST' }),
    onSuccess: (data) => window.location.assign(data.logoutUrl),
  });
  const initial = (displayName.trim()[0] ?? '?').toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label={t('header.loggedInAs', { name: displayName })} size="icon-md">
          <span className="flex size-5 items-center justify-center rounded-full bg-surface-3 text-2xs font-medium text-text">
            {initial}
          </span>
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>
          <div className="text-sm font-medium text-text">{displayName}</div>
          <div className="text-xs font-normal text-text-tertiary">{t(ROLE_LABEL[role])}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={logout.isPending} onSelect={() => logout.mutate()}>
          <LogOut size={16} aria-hidden="true" />
          {t('header.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ── Topbar ── */

/** Czy keydown pochodzi z pola edycji (wtedy skróty jednoliterowe ignorujemy). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

export interface TopbarProps {
  displayName: string;
  role: Role;
  onToggleSidebar: () => void;
}

export function Topbar({ displayName, role, onToggleSidebar }: TopbarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const title = pageTitle(pathname);

  // Skrót '[' — toggle sidebara (ignoruje pola edycji i modyfikatory).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      onToggleSidebar();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onToggleSidebar]);

  return (
    <header className="sticky top-0 z-(--z-shell) flex h-12 items-center gap-2 border-b border-border bg-bg/80 px-3 backdrop-blur">
      <span className="hidden md:inline-flex">
        <IconButton aria-label={t('shell.sidebar.toggle')} size="icon-md" onClick={onToggleSidebar}>
          <PanelLeft size={16} aria-hidden="true" />
        </IconButton>
      </span>
      {title !== undefined && <h1 className="truncate text-sm font-medium">{title}</h1>}
      <div className="grow" />
      <Button variant="secondary" size="sm" iconLeft={<Search size={14} aria-hidden="true" />} onClick={() => setPaletteOpen(true)}>
        <span className="hidden sm:inline">{t('header.search')}</span>
        <Kbd>⌘K</Kbd>
      </Button>
      <HealthMenu />
      <ThemeMenu />
      <UserMenu displayName={displayName} role={role} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} role={role} />
    </header>
  );
}
