/**
 * Dolny pasek nawigacji <768px: max 5 slotów wg roli (mobileItems) +
 * „Więcej" otwierające sheet z pełną listą sekcji.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/ui/sheet';
import { cn } from '@/ui/cn';
import type { Role } from '@/lib/permissions';
import { t } from '@/i18n/t';
import { mobileItems, visibleSections, type NavItem } from './nav';

const SLOT_CLASS =
  'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md py-1 text-2xs text-text-secondary';

function MobileSlot({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.path}
      className={cn(SLOT_CLASS, 'data-[status=active]:text-accent')}
      activeProps={{ className: 'font-medium' }}
    >
      <Icon size={20} aria-hidden="true" />
      <span className="truncate">{t(item.labelKey)}</span>
    </Link>
  );
}

export function MobileNav({ role }: { role: Role }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const plan = mobileItems(role);
  if (plan.items.length === 0) return null;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-(--z-shell) flex h-14 items-stretch gap-1 border-t border-border bg-surface px-2 pb-[env(safe-area-inset-bottom)] md:hidden"
      aria-label="Nawigacja mobilna"
    >
      {plan.items.map((item) => (
        <MobileSlot key={item.path} item={item} />
      ))}
      {plan.more && (
        <>
          <button type="button" className={SLOT_CLASS} onClick={() => setMoreOpen(true)}>
            <MoreHorizontal size={20} aria-hidden="true" />
            <span className="truncate">{t('nav.more')}</span>
          </button>
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetContent side="bottom">
              <SheetHeader>
                <SheetTitle>{t('nav.moreTitle')}</SheetTitle>
              </SheetHeader>
              <SheetBody>
                <div className="flex flex-col gap-1 pb-[env(safe-area-inset-bottom)]">
                  {visibleSections(role).map((section) => (
                    <div key={section.labelKey} className="flex flex-col gap-0.5">
                      <div className="px-2 pt-3 pb-1 text-2xs font-medium uppercase tracking-(--tracking-label) text-text-tertiary">
                        {t(section.labelKey)}
                      </div>
                      {section.items.map((item) => {
                        const Icon = item.icon;
                        return (
                          <Link
                            key={item.path}
                            to={item.path}
                            className="flex h-9 items-center gap-2.5 rounded-md px-2 text-sm text-text-secondary data-[status=active]:text-text"
                            activeProps={{ className: 'bg-surface-3 font-medium' }}
                            onClick={() => setMoreOpen(false)}
                          >
                            <Icon size={16} aria-hidden="true" className="shrink-0" />
                            {t(item.labelKey)}
                          </Link>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </SheetBody>
            </SheetContent>
          </Sheet>
        </>
      )}
    </nav>
  );
}
