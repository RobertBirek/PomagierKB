import { useEffect, useRef } from 'react';
import { StatusBadgeV2 as StatusBadge } from './kb/StatusBadgeV2';
import { isTerminalActionStatus, useAction, type ActionState } from '../hooks/useAction';
import { t } from '../i18n/t';

/**
 * Pasek postępu długobieżnej akcji (202+actionId) + rozwijany log techniczny.
 * Dane z useAction (SSE z fallbackiem na polling). Soczewka product: człowiek
 * widzi etap i procent; surowe linie logu tylko po rozwinięciu „szczegółów".
 */

function progressPercent(progress: Record<string, unknown> | null): number | null {
  if (progress === null) return null;
  const percent = progress['percent'];
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    return Math.max(0, Math.min(100, percent));
  }
  const current = progress['current'];
  const total = progress['total'];
  if (typeof current === 'number' && typeof total === 'number' && total > 0) {
    return Math.max(0, Math.min(100, (current / total) * 100));
  }
  return null;
}

function progressStep(progress: Record<string, unknown> | null): string | null {
  if (progress === null) return null;
  for (const key of ['stepLabel', 'message', 'step', 'stage']) {
    const value = progress[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

export interface ActionProgressProps {
  actionId: string | null;
  /** Wywołane RAZ, gdy akcja osiągnie status terminalny (success/error/cancelled). */
  onFinished?: (state: ActionState) => void;
}

export function ActionProgress({ actionId, onFinished }: ActionProgressProps) {
  const action = useAction(actionId);
  const notifiedFor = useRef<string | null>(null);

  useEffect(() => {
    if (actionId === null) {
      notifiedFor.current = null;
      return;
    }
    if (isTerminalActionStatus(action.status) && notifiedFor.current !== actionId) {
      notifiedFor.current = actionId;
      onFinished?.(action);
    }
  }, [actionId, action, onFinished]);

  if (actionId === null) return null;

  const percent = progressPercent(action.progress);
  const step = progressStep(action.progress);
  const running = action.status === 'running';

  return (
    <div className="stack action-progress">
      <div className="row">
        <StatusBadge status={action.status} />
        {step !== null && <span className="muted">{step}</span>}
        {percent !== null && <span className="muted">{Math.round(percent)}%</span>}
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent !== null ? { 'aria-valuenow': Math.round(percent) } : {})}
      >
        <div
          className={running && percent === null ? 'progress-fill progress-indeterminate' : 'progress-fill'}
          style={{ width: percent !== null ? `${percent}%` : running ? '40%' : '100%' }}
        />
      </div>
      {action.logTail.length > 0 && (
        <details className="action-log">
          <summary className="muted">{t('action.logDetails')}</summary>
          <pre className="log-pre">{action.logTail.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}
