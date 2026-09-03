/**
 * Command palette — MINIMALNY placeholder (pełna paleta poleceń w Fazie 3):
 * dialog z listą pozycji nawigacji filtrowaną inputem; strzałki + Enter,
 * skrót Cmd+K / Ctrl+K.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { cn } from '@/ui/cn';
import type { Role } from '@/lib/permissions';
import { t } from '@/i18n/t';
import { visibleItems } from './nav';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: Role;
}

export function CommandPalette({ open, onOpenChange, role }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  // Globalny skrót Cmd+K / Ctrl+K (toggle).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  // Reset stanu przy każdym otwarciu.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  const items = useMemo(() => {
    const all = visibleItems(role);
    const q = query.trim().toLowerCase();
    if (q === '') return all;
    return all.filter(
      (item) => t(item.labelKey).toLowerCase().includes(q) || item.path.toLowerCase().includes(q),
    );
  }, [role, query]);

  const go = (path: string) => {
    onOpenChange(false);
    void navigate({ to: path });
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[Math.min(activeIndex, items.length - 1)];
      if (item !== undefined) go(item.path);
    }
  };

  const active = Math.min(activeIndex, Math.max(items.length - 1, 0));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="sr-only">{t('header.commandPalette.title')}</DialogTitle>
        <input
          // autoFocus zamierzony: fokus w polu to cały sens skrótu ⌘K
          autoFocus
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={items.length > 0 ? `command-palette-item-${active}` : undefined}
          className={cn(
            'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text',
            'placeholder:text-text-tertiary focus:outline-none',
          )}
          placeholder={t('header.commandPalette.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onInputKeyDown}
        />
        <ul id="command-palette-list" role="listbox" className="mt-2 flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {items.length === 0 && (
            <li className="px-2 py-3 text-sm text-text-tertiary">{t('header.commandPalette.empty')}</li>
          )}
          {items.map((item, idx) => {
            const Icon = item.icon;
            return (
              <li
                key={item.path}
                id={`command-palette-item-${idx}`}
                role="option"
                aria-selected={idx === active}
                className={cn(
                  'flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm text-text-secondary',
                  idx === active && 'bg-surface-2 text-text',
                )}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => go(item.path)}
              >
                <Icon size={16} aria-hidden="true" className="shrink-0" />
                <span className="truncate">{t(item.labelKey)}</span>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
