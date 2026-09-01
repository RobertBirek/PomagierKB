import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n/t';

export type ToastKind = 'info' | 'ok' | 'warn' | 'fail';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  /** Pokaż powiadomienie (auto-znika po 5 s; fail po 8 s). */
  show: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Hook powiadomień: const toast = useToast(); toast.show('Zapisano', 'ok'). */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast wymaga <ToastProvider> (main.tsx)');
  return api;
}

const KIND_CLASS: Record<ToastKind, string> = {
  info: 'toast',
  ok: 'toast toast-ok',
  warn: 'toast toast-warn',
  fail: 'toast toast-fail',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = nextId.current++;
      setItems((prev) => [...prev, { id, kind, message }]);
      window.setTimeout(() => dismiss(id), kind === 'fail' ? 8000 : 5000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={KIND_CLASS[item.kind]}>
            <div className="row">
              <span className="grow">{item.message}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t('toast.dismiss')}
                onClick={() => dismiss(item.id)}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
