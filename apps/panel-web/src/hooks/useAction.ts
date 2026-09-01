import { useEffect, useRef, useState } from 'react';
import { apiFetch, apiSse } from '../lib/api';

/**
 * Obserwacja długobieżnej akcji (202+actionId — build KB, create_kb, quality…).
 * Preferuje SSE GET /api/v1/actions/:id/events (eventy: progress / log {lines} /
 * status terminalny kończy strumień); gdy strumień nie wstanie — fallback na
 * polling GET /api/v1/actions/:id co 2 s. Zwraca {status, progress, logTail}.
 */

export type ActionRunStatus = 'running' | 'success' | 'error' | 'cancelled' | 'unknown';

export interface ActionState {
  status: ActionRunStatus;
  exitCode: number | null;
  /** Surowy progress_json akcji (kształt zależny od typu akcji). */
  progress: Record<string, unknown> | null;
  /** Ostatnie linie logu (SSE: narastająco od początku pliku; poll: tail z API). */
  logTail: string[];
  /** Kanał danych: sse | poll | idle (brak actionId). */
  transport: 'sse' | 'poll' | 'idle';
}

interface ActionDto {
  status?: string;
  exitCode?: number | null;
  progress?: Record<string, unknown> | null;
  logTail?: string[];
}

const LOG_CAP = 500;
const TERMINAL: readonly ActionRunStatus[] = ['success', 'error', 'cancelled'];

function asRunStatus(raw: unknown): ActionRunStatus {
  return raw === 'running' || raw === 'success' || raw === 'error' || raw === 'cancelled'
    ? raw
    : 'unknown';
}

export function isTerminalActionStatus(status: ActionRunStatus): boolean {
  return TERMINAL.includes(status);
}

const IDLE: ActionState = { status: 'unknown', exitCode: null, progress: null, logTail: [], transport: 'idle' };

export function useAction(actionId: string | null): ActionState {
  const [state, setState] = useState<ActionState>(IDLE);
  // Bufor logu poza stanem — SSE potrafi dosypać wiele eventów między renderami.
  const logRef = useRef<string[]>([]);

  useEffect(() => {
    if (actionId === null) {
      setState(IDLE);
      return;
    }
    logRef.current = [];
    setState({ ...IDLE, status: 'running', transport: 'sse' });
    const controller = new AbortController();
    let pollTimer: number | undefined;
    let stopped = false;

    const applyDto = (dto: ActionDto, transport: 'sse' | 'poll'): void => {
      if (stopped) return;
      if (Array.isArray(dto.logTail)) logRef.current = dto.logTail.slice(-LOG_CAP);
      setState({
        status: asRunStatus(dto.status),
        exitCode: dto.exitCode ?? null,
        progress: dto.progress ?? null,
        logTail: logRef.current,
        transport,
      });
    };

    const pollOnce = async (): Promise<void> => {
      try {
        const dto = await apiFetch<ActionDto>(`/api/v1/actions/${actionId}`, { signal: controller.signal });
        applyDto(dto, 'poll');
        if (isTerminalActionStatus(asRunStatus(dto.status))) {
          window.clearInterval(pollTimer);
        }
      } catch {
        /* chwilowy błąd sieci — następny tick spróbuje ponownie */
      }
    };

    const startPolling = (): void => {
      if (stopped) return;
      setState((prev) => ({ ...prev, transport: 'poll' }));
      void pollOnce();
      pollTimer = window.setInterval(() => void pollOnce(), 2000);
    };

    const onSseEvent = (ev: { event: string; data: string }): void => {
      if (stopped) return;
      let payload: unknown = null;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof payload !== 'object' || payload === null) return;
      const obj = payload as Record<string, unknown>;
      if (ev.event === 'log' && Array.isArray(obj['lines'])) {
        const lines = (obj['lines'] as unknown[]).filter((l): l is string => typeof l === 'string');
        logRef.current = [...logRef.current, ...lines].slice(-LOG_CAP);
        setState((prev) => ({ ...prev, logTail: logRef.current }));
      } else if (ev.event === 'progress') {
        setState((prev) => ({ ...prev, progress: obj }));
      } else if (ev.event === 'status') {
        setState((prev) => ({
          ...prev,
          status: asRunStatus(obj['status']),
          exitCode: typeof obj['exitCode'] === 'number' ? obj['exitCode'] : prev.exitCode,
        }));
      }
    };

    void apiSse(`/api/v1/actions/${actionId}/events`, undefined, {
      method: 'GET',
      onEvent: onSseEvent,
      signal: controller.signal,
    }).catch((err: unknown) => {
      // Abort = odmontowanie; inne błędy → siatka bezpieczeństwa: polling.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      startPolling();
    });

    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(pollTimer);
    };
  }, [actionId]);

  return state;
}
