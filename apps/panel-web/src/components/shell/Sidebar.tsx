/**
 * Sidebar APP SHELL v2 (Linear-like): 240px / zwinięty 56px (same ikony
 * z tooltipami), stan zapamiętany w localStorage. Ukryty <768px (MobileNav).
 */
import { useCallback, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/ui/badge';
import { Tooltip } from '@/ui/tooltip';
import { cn } from '@/ui/cn';
import { useStatus } from '@/hooks/useStatus';
import type { Role } from '@/lib/permissions';
import { t } from '@/i18n/t';
import { pendingDraftsFromStatus, visibleSections, type NavItem } from './nav';

const STORAGE_KEY = 'pomagierkb.sidebar';

/** Stan zwinięcia sidebara + toggle; persist w localStorage 'pomagierkb.sidebar'. */
export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === 'collapsed';
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? 'collapsed' : 'expanded');
      } catch {
        /* prywatny tryb — stan nie przetrwa odświeżenia */
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

function SidebarItem({
  item,
  collapsed,
  pendingDrafts,
}: {
  item: NavItem;
  collapsed: boolean;
  pendingDrafts: number | undefined;
}) {
  const Icon = item.icon;
  const label = t(item.labelKey);
  const count = item.badge === 'pendingDrafts' ? pendingDrafts : undefined;

  const link = (
    <Link
      to={item.path}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-text-secondary',
        'hover:bg-surface-2 hover:text-text',
        'data-[status=active]:text-text',
        collapsed && 'justify-center px-0',
      )}
      activeProps={{ className: 'bg-surface-3 font-medium' }}
    >
      <Icon size={16} aria-hidden="true" className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && count !== undefined && count > 0 && (
        <span className="ml-auto">
          <Badge variant="accent" tone="tint">
            {count}
          </Badge>
        </span>
      )}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Tooltip content={count !== undefined && count > 0 ? `${label} (${count})` : label} side="right">
      {link}
    </Tooltip>
  );
}

export interface SidebarProps {
  role: Role;
  collapsed: boolean;
}

export function Sidebar({ role, collapsed }: SidebarProps) {
  const status = useStatus();
  const pendingDrafts = pendingDraftsFromStatus(status.data?.components);
  const sections = visibleSections(role);

  return (
    <aside
      className={cn(
        'hidden md:flex sticky top-0 h-dvh shrink-0 flex-col overflow-y-auto',
        'border-r border-border bg-surface transition-[width] duration-(--duration-slow)',
        collapsed ? 'w-14' : 'w-60',
      )}
    >
      <div className={cn('flex h-12 shrink-0 items-center gap-2 px-3', collapsed && 'justify-center px-0')}>
        <Link to="/" className="flex items-center gap-2" aria-label="PomagierKB">
          <span
            aria-hidden="true"
            className="flex size-5 items-center justify-center rounded-md bg-accent text-2xs font-semibold text-on-accent"
          >
            P
          </span>
          {!collapsed && <span className="text-sm font-semibold">PomagierKB</span>}
        </Link>
      </div>
      <nav className={cn('flex flex-col px-2 pb-4', collapsed && 'items-stretch')} aria-label="Nawigacja">
        {sections.map((section, idx) => (
          <div key={section.labelKey} className="flex flex-col gap-0.5">
            {collapsed ? (
              idx > 0 && <div className="mx-1 my-2 h-px bg-border" aria-hidden="true" />
            ) : (
              <div className="px-2 pt-4 pb-1 text-2xs font-medium uppercase tracking-(--tracking-label) text-text-tertiary">
                {t(section.labelKey)}
              </div>
            )}
            {section.items.map((item) => (
              <SidebarItem key={item.path} item={item} collapsed={collapsed} pendingDrafts={pendingDrafts} />
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
