/**
 * Toast v2 — WSTECZNIE ZGODNY z components/Toast.tsx:
 * useToast().show(message, kind?) działa bez zmian; nowy interfejs
 * push({ title, description?, kind?, duration?, action? }) daje tytuł+opis,
 * własny czas życia i przycisk akcji (np. „Cofnij").
 *
 * Zachowanie: maks. 3 widoczne + kolejka FIFO; hover wstrzymuje timer
 * (pozostały czas zapamiętany); fail = role="alert"/assertive.
 * Logika kolejki: toast-queue.ts (czysta, testowana bez DOM).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from './cn';
import { t } from '../i18n/t';
import { createToastQueue, type ToastEntry, type ToastInput, type ToastKind, type ToastQueue } from './toast-queue';
import './overlays.css';

export type { ToastAction, ToastEntry, ToastInput, ToastKind } from './toast-queue';

export interface ToastApi {
  /** Zgodne ze starym kontraktem: auto-znika po 5 s (fail 8 s). */
  show: (message: string, kind?: ToastKind) => void;
  /** Pełny toast: tytuł + opis + akcja + własny czas życia. Zwraca id. */
  push: (input: ToastInput) => number;
  /** Ręczne zamknięcie (np. po sukcesie akcji „Cofnij"). */
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Hook powiadomień: const toast = useToast(); toast.show('Zapisano', 'ok'). */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast wymaga <ToastProvider> (main.tsx)');
  return api;
}

const KIND_ICON: Record<ToastKind, ReactNode> = {
  info: <Info size={16} className="shrink-0 text-info" aria-hidden />,
  ok: <CircleCheck size={16} className="shrink-0 text-ok" aria-hidden />,
  warn: <TriangleAlert size={16} className="shrink-0 text-warn" aria-hidden />,
  fail: <CircleX size={16} className="shrink-0 text-fail" aria-hidden />,
};

/** Czas trwania animacji wyjścia (musi pokrywać ui-toast-out). */
const EXIT_MS = 200;

function ToastCard({ entry, leaving, queue }: { entry: ToastEntry; leaving: boolean; queue: ToastQueue }) {
  const isFail = entry.kind === 'fail';
  return (
    <div
      role={isFail ? 'alert' : 'status'}
      aria-live={isFail ? 'assertive' : 'polite'}
      onMouseEnter={() => queue.pause(entry.id)}
      onMouseLeave={() => queue.resume(entry.id)}
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 shadow-md',
        leaving ? 'ui-toast-out pointer-events-none' : 'ui-toast-in',
      )}
    >
      <span className="mt-0.5">{KIND_ICON[entry.kind]}</span>
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <div className="text-sm font-medium text-text">{entry.title}</div>
        {entry.description !== undefined && <div className="text-sm text-text-secondary">{entry.description}</div>}
        {entry.action !== undefined && (
          <button
            type="button"
            className="mt-1 self-start rounded-md px-2 py-1 text-sm font-medium text-accent transition-colors hover:bg-accent-tint"
            onClick={() => {
              entry.action?.onClick();
              queue.dismiss(entry.id);
            }}
          >
            {entry.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={t('ui.dismiss')}
        onClick={() => queue.dismiss(entry.id)}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  // Kolejka żyje przez cały cykl providera — leniwie w useState (bez ref-dance).
  const [queue] = useState(() => createToastQueue({ limit: 3 }));
  const visible = useSyncExternalStore(queue.subscribe, queue.getVisible);

  // Toasty w trakcie animacji wyjścia — chwilę po usunięciu z kolejki.
  const [leaving, setLeaving] = useState<readonly ToastEntry[]>([]);
  const prevVisible = useRef<readonly ToastEntry[]>([]);
  useEffect(() => {
    const prev = prevVisible.current;
    prevVisible.current = visible;
    const gone = prev.filter((entry) => !visible.some((v) => v.id === entry.id));
    if (gone.length === 0) return;
    setLeaving((current) => [...current, ...gone]);
    const handle = window.setTimeout(() => {
      setLeaving((current) => current.filter((entry) => !gone.some((g) => g.id === entry.id)));
    }, EXIT_MS);
    return () => window.clearTimeout(handle);
  }, [visible]);

  useEffect(() => () => queue.clear(), [queue]);

  const show = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      queue.push({ title: message, kind });
    },
    [queue],
  );

  const api = useMemo<ToastApi>(
    () => ({ show, push: queue.push, dismiss: queue.dismiss }),
    [show, queue],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* mobile: bottom-20 — nad dolną nawigacją; >=768px: bottom-4 */}
      <div className="pointer-events-none fixed bottom-20 right-4 z-(--z-toast) flex w-[calc(100vw-32px)] max-w-[380px] flex-col gap-2 md:bottom-4">
        {visible.map((entry) => (
          <ToastCard key={entry.id} entry={entry} leaving={false} queue={queue} />
        ))}
        {leaving.map((entry) => (
          <ToastCard key={`leaving-${entry.id}`} entry={entry} leaving queue={queue} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
