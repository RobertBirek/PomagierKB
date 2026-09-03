/**
 * Testy czystej logiki kolejki toastów (design system v2) — bez DOM/React.
 * Fake timers sterują auto-zamykaniem i pauzą hover (zapamiętany remaining).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastQueue } from '../src/ui/toast-queue';

describe('createToastQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('push pokazuje toast i auto-zamyka po 5 s (info) / 8 s (fail)', () => {
    const q = createToastQueue({ limit: 3 });
    q.push({ title: 'Zapisano', kind: 'ok' });
    q.push({ title: 'Błąd', kind: 'fail' });
    expect(q.getVisible().map((t) => t.title)).toEqual(['Zapisano', 'Błąd']);

    vi.advanceTimersByTime(5000);
    expect(q.getVisible().map((t) => t.title)).toEqual(['Błąd']);
    vi.advanceTimersByTime(3000); // fail żyje 8 s łącznie
    expect(q.getVisible()).toEqual([]);
  });

  it('limit widocznych + kolejka FIFO: nadmiar czeka i wchodzi w kolejności', () => {
    const q = createToastQueue({ limit: 3 });
    const ids = [1, 2, 3, 4, 5].map((n) => q.push({ title: `t${n}` }));
    expect(q.getVisible().map((t) => t.title)).toEqual(['t1', 't2', 't3']);
    expect(q.getPending().map((t) => t.title)).toEqual(['t4', 't5']);

    const firstId = ids[0];
    if (firstId === undefined) throw new Error('brak id');
    q.dismiss(firstId);
    // t4 promowany jako pierwszy (FIFO), t5 dalej czeka
    expect(q.getVisible().map((t) => t.title)).toEqual(['t2', 't3', 't4']);
    expect(q.getPending().map((t) => t.title)).toEqual(['t5']);
  });

  it('toast promowany z kolejki dostaje PEŁNY timer od momentu pokazania', () => {
    const q = createToastQueue({ limit: 1 });
    const a = q.push({ title: 'a', duration: 1000 });
    q.push({ title: 'b', duration: 1000 });
    vi.advanceTimersByTime(900); // b wciąż w kolejce — jego timer nie biegnie
    q.dismiss(a);
    expect(q.getVisible().map((t) => t.title)).toEqual(['b']);
    vi.advanceTimersByTime(900);
    expect(q.getVisible().map((t) => t.title)).toEqual(['b']); // pełne 1000 ms od promocji
    vi.advanceTimersByTime(100);
    expect(q.getVisible()).toEqual([]);
  });

  it('pause (hover) zatrzymuje timer i zapamiętuje remaining; resume wznawia od niego', () => {
    const q = createToastQueue({ limit: 3 });
    const id = q.push({ title: 'hover', duration: 5000 });

    vi.advanceTimersByTime(3000);
    q.pause(id);
    vi.advanceTimersByTime(60_000); // długi hover — toast nie znika
    expect(q.getVisible()).toHaveLength(1);

    q.resume(id);
    vi.advanceTimersByTime(1999); // remaining = 2000
    expect(q.getVisible()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(q.getVisible()).toEqual([]);
  });

  it('duration Infinity/<=0 = sticky (bez auto-zamykania), dismiss działa ręcznie', () => {
    const q = createToastQueue({ limit: 3 });
    const sticky = q.push({ title: 'sticky', duration: Infinity });
    q.push({ title: 'zero', duration: 0 });
    vi.advanceTimersByTime(600_000);
    expect(q.getVisible().map((t) => t.title)).toEqual(['sticky', 'zero']);
    q.dismiss(sticky);
    expect(q.getVisible().map((t) => t.title)).toEqual(['zero']);
  });

  it('dismiss toastu oczekującego usuwa go z kolejki (nie wejdzie po promocji)', () => {
    const q = createToastQueue({ limit: 1 });
    const a = q.push({ title: 'a' });
    q.push({ title: 'b' });
    const c = q.push({ title: 'c' });
    q.dismiss(c); // c jeszcze niewidoczny
    expect(q.getPending().map((t) => t.title)).toEqual(['b']);
    q.dismiss(a);
    expect(q.getVisible().map((t) => t.title)).toEqual(['b']);
    expect(q.getPending()).toEqual([]);
  });

  it('subscribe powiadamia o zmianach; snapshot getVisible jest stabilny między zmianami', () => {
    const q = createToastQueue({ limit: 3 });
    const listener = vi.fn();
    const unsubscribe = q.subscribe(listener);

    const id = q.push({ title: 'x' });
    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = q.getVisible();
    expect(q.getVisible()).toBe(snapshot); // stabilna referencja (useSyncExternalStore)

    q.dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    q.push({ title: 'y' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('push zachowuje description i action; clear zatrzymuje wszystko', () => {
    const q = createToastQueue({ limit: 3 });
    const onClick = vi.fn();
    q.push({ title: 'Usunięto', description: 'Wpis trafił do kosza', kind: 'warn', action: { label: 'Cofnij', onClick } });
    const entry = q.getVisible()[0];
    expect(entry?.description).toBe('Wpis trafił do kosza');
    expect(entry?.action?.label).toBe('Cofnij');
    entry?.action?.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);

    q.clear();
    expect(q.getVisible()).toEqual([]);
    expect(q.getPending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
