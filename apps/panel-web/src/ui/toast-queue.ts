/**
 * Czysta logika kolejki toastów (bez React/DOM) — testowana w
 * test/ui-overlays.test.ts z fake timers. Provider w toast.tsx tylko renderuje.
 *
 * Zasady:
 * - maks. `limit` toastów widocznych naraz; nadmiar czeka w kolejce FIFO,
 * - każdy widoczny toast ma timer auto-zamknięcia (fail 8 s, reszta 5 s,
 *   chyba że podano `duration`; duration <= 0 lub Infinity = bez timera),
 * - pause/resume (hover) zapamiętuje pozostały czas i wznawia od niego,
 * - dismiss promuje kolejne toasty z kolejki (z pełnym timerem).
 */

export type ToastKind = 'info' | 'ok' | 'warn' | 'fail';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  title: string;
  description?: string;
  kind?: ToastKind;
  /** Czas życia w ms; <= 0 lub Infinity = toast nie znika sam. */
  duration?: number;
  action?: ToastAction;
}

export interface ToastEntry {
  id: number;
  title: string;
  description?: string;
  kind: ToastKind;
  duration: number;
  action?: ToastAction;
}

export interface ToastQueue {
  /** Dodaje toast; zwraca id (do dismiss). */
  push: (input: ToastInput) => number;
  /** Usuwa toast (widoczny lub oczekujący) i promuje kolejkę. */
  dismiss: (id: number) => void;
  /** Wstrzymuje timer (hover) — zapamiętuje pozostały czas. */
  pause: (id: number) => void;
  /** Wznawia timer od zapamiętanego pozostałego czasu. */
  resume: (id: number) => void;
  /** Subskrypcja zmian; zwraca unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Stabilny snapshot widocznych toastów (dla useSyncExternalStore). */
  getVisible: () => readonly ToastEntry[];
  /** Toasty oczekujące w kolejce FIFO (diagnostyka/testy). */
  getPending: () => readonly ToastEntry[];
  /** Czyści wszystko i zatrzymuje timery (unmount providera). */
  clear: () => void;
}

const DEFAULT_DURATION = 5000;
const FAIL_DURATION = 8000;

interface TimerState {
  handle: ReturnType<typeof setTimeout> | null;
  /** Znacznik startu bieżącego odcinka timera. */
  startedAt: number;
  /** Ile ms zostało do auto-zamknięcia (aktualizowane przy pauzie). */
  remaining: number;
}

export function createToastQueue({ limit = 3 }: { limit?: number } = {}): ToastQueue {
  let nextId = 1;
  let visible: ToastEntry[] = [];
  let pending: ToastEntry[] = [];
  const timers = new Map<number, TimerState>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function startTimer(entry: ToastEntry, remaining: number): void {
    if (!Number.isFinite(remaining) || remaining <= 0) return; // sticky
    const handle = setTimeout(() => dismiss(entry.id), remaining);
    timers.set(entry.id, { handle, startedAt: Date.now(), remaining });
  }

  function stopTimer(id: number): void {
    const timer = timers.get(id);
    if (timer?.handle != null) clearTimeout(timer.handle);
    timers.delete(id);
  }

  /** Dopełnia widoczne z kolejki FIFO (po dismiss). */
  function promote(): void {
    while (visible.length < limit && pending.length > 0) {
      const entry = pending[0];
      if (entry === undefined) break;
      pending = pending.slice(1);
      visible = [...visible, entry];
      startTimer(entry, entry.duration);
    }
  }

  function push(input: ToastInput): number {
    const id = nextId++;
    const kind = input.kind ?? 'info';
    const entry: ToastEntry = {
      id,
      title: input.title,
      kind,
      duration: input.duration ?? (kind === 'fail' ? FAIL_DURATION : DEFAULT_DURATION),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
    };
    if (visible.length < limit) {
      visible = [...visible, entry];
      startTimer(entry, entry.duration);
    } else {
      pending = [...pending, entry];
    }
    notify();
    return id;
  }

  function dismiss(id: number): void {
    stopTimer(id);
    const wasVisible = visible.some((entry) => entry.id === id);
    if (wasVisible) {
      visible = visible.filter((entry) => entry.id !== id);
      promote();
      notify();
      return;
    }
    const wasPending = pending.some((entry) => entry.id === id);
    if (wasPending) {
      pending = pending.filter((entry) => entry.id !== id);
      notify();
    }
  }

  function pause(id: number): void {
    const timer = timers.get(id);
    if (timer === undefined || timer.handle === null) return;
    clearTimeout(timer.handle);
    const elapsed = Date.now() - timer.startedAt;
    timer.handle = null;
    timer.remaining = Math.max(0, timer.remaining - elapsed);
  }

  function resume(id: number): void {
    const timer = timers.get(id);
    if (timer === undefined || timer.handle !== null) return; // brak pauzy = nic do zrobienia
    if (timer.remaining <= 0) {
      dismiss(id);
      return;
    }
    timer.handle = setTimeout(() => dismiss(id), timer.remaining);
    timer.startedAt = Date.now();
  }

  function clear(): void {
    for (const id of [...timers.keys()]) stopTimer(id);
    visible = [];
    pending = [];
    notify();
  }

  return {
    push,
    dismiss,
    pause,
    resume,
    clear,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVisible: () => visible,
    getPending: () => pending,
  };
}
