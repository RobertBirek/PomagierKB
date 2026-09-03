/**
 * Testy prymitywów UI v2 (bez renderowania DOM — środowisko node):
 * warianty CVA jako czyste funkcje + logika debounce SearchInputa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertVariants } from '../src/ui/alert';
import { badgeVariants } from '../src/ui/badge';
import { buttonVariants, iconButtonVariants } from '../src/ui/button';
import { createDebouncer } from '../src/ui/search-input';

describe('buttonVariants', () => {
  it('domyślnie secondary md (h-8, surface + border)', () => {
    const cls = buttonVariants({});
    expect(cls).toContain('h-8');
    expect(cls).toContain('bg-surface');
    expect(cls).toContain('border-border-strong');
    expect(cls).toContain('text-sm');
    expect(cls).toContain('font-medium');
  });

  it('primary = accent + on-accent', () => {
    const cls = buttonVariants({ variant: 'primary' });
    expect(cls).toContain('bg-accent');
    expect(cls).toContain('text-on-accent');
    expect(cls).toContain('hover:bg-accent-hover');
  });

  it('danger = bg-fail text-white', () => {
    const cls = buttonVariants({ variant: 'danger' });
    expect(cls).toContain('bg-fail');
    expect(cls).toContain('text-white');
  });

  it('rozmiary sm/md/lg = h-7/h-8/h-9', () => {
    expect(buttonVariants({ size: 'sm' })).toContain('h-7');
    expect(buttonVariants({ size: 'md' })).toContain('h-8');
    expect(buttonVariants({ size: 'lg' })).toContain('h-9');
  });

  it('ghost bez tła i bez bordera w spoczynku', () => {
    const cls = buttonVariants({ variant: 'ghost' });
    expect(cls).not.toContain('bg-surface ');
    expect(cls).not.toContain('border-border-strong');
    expect(cls).toContain('hover:bg-surface-2');
  });
});

describe('iconButtonVariants', () => {
  it('domyślnie ghost icon-md (32px)', () => {
    const cls = iconButtonVariants({});
    expect(cls).toContain('size-8');
    expect(cls).toContain('hover:bg-surface-2');
  });

  it('icon-sm = 28px', () => {
    expect(iconButtonVariants({ size: 'icon-sm' })).toContain('size-7');
  });
});

describe('badgeVariants', () => {
  it('domyślnie neutral tint', () => {
    const cls = badgeVariants({});
    expect(cls).toContain('bg-surface-2');
    expect(cls).toContain('text-text-secondary');
    expect(cls).toContain('rounded-full');
    expect(cls).toContain('h-5');
    expect(cls).toContain('text-2xs');
  });

  it('warianty statusowe tint = tło-tint + tekst statusowy', () => {
    expect(badgeVariants({ variant: 'ok' })).toContain('bg-ok-tint');
    expect(badgeVariants({ variant: 'ok' })).toContain('text-ok');
    expect(badgeVariants({ variant: 'fail' })).toContain('bg-fail-tint');
    expect(badgeVariants({ variant: 'accent' })).toContain('bg-accent-tint');
  });

  it('outline bez tła tint, z borderem statusowym', () => {
    const cls = badgeVariants({ variant: 'fail', tone: 'outline' });
    expect(cls).not.toContain('bg-fail-tint');
    expect(cls).toContain('border-fail/40');
    expect(cls).toContain('text-fail');
  });
});

describe('alertVariants', () => {
  it('domyślnie info (tint + border/25)', () => {
    const cls = alertVariants({});
    expect(cls).toContain('bg-info-tint');
    expect(cls).toContain('border-info/25');
  });

  it('warn/fail mają własne tinty', () => {
    expect(alertVariants({ variant: 'warn' })).toContain('bg-warn-tint');
    expect(alertVariants({ variant: 'fail' })).toContain('bg-fail-tint');
  });
});

describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wywołuje fn dopiero po delay', () => {
    const d = createDebouncer(300);
    const fn = vi.fn();
    d.schedule(fn);
    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('kolejny schedule resetuje timer (tylko ostatnie fn)', () => {
    const d = createDebouncer(300);
    const first = vi.fn();
    const second = vi.fn();
    d.schedule(first);
    vi.advanceTimersByTime(200);
    d.schedule(second);
    vi.advanceTimersByTime(299);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('cancel odwołuje zaplanowane wywołanie', () => {
    const d = createDebouncer(300);
    const fn = vi.fn();
    d.schedule(fn);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel bez zaplanowanego wywołania nie rzuca', () => {
    const d = createDebouncer(300);
    expect(() => d.cancel()).not.toThrow();
  });

  it('po wykonaniu można zaplanować kolejne', () => {
    const d = createDebouncer(100);
    const fn = vi.fn();
    d.schedule(fn);
    vi.advanceTimersByTime(100);
    d.schedule(fn);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
