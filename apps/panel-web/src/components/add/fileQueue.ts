/**
 * Kolejka wielu plików na /add — CZYSTY reducer bez React/DOM (obiekty File
 * trzyma strona w ref; tu tylko metadane i cykl życia). Wysyłka sekwencyjna:
 * strona bierze kolejny 'queued', dispatchuje start/progress/done/fail.
 * Testy: test/add-fileQueue.test.ts.
 */

export type FileQueueStatus = 'queued' | 'uploading' | 'done' | 'failed';

export interface FileQueueItem {
  id: string;
  name: string;
  size: number;
  status: FileQueueStatus;
  /** Postęp wysyłki 0..1 (znaczący tylko dla 'uploading'). */
  progress: number;
  error?: string;
  intakeId?: string;
  deduplicated?: boolean;
}

export type FileQueueAction =
  | { type: 'add'; items: readonly { id: string; name: string; size: number }[] }
  | { type: 'remove'; id: string }
  | { type: 'start'; id: string }
  | { type: 'progress'; id: string; progress: number }
  | { type: 'done'; id: string; intakeId: string; deduplicated: boolean }
  | { type: 'fail'; id: string; error: string }
  | { type: 'clearFinished' }
  | { type: 'reset' };

export function fileQueueReducer(
  state: readonly FileQueueItem[],
  action: FileQueueAction,
): readonly FileQueueItem[] {
  switch (action.type) {
    case 'add': {
      const known = new Set(state.map((item) => item.id));
      const added = action.items
        .filter((item) => !known.has(item.id))
        .map<FileQueueItem>((item) => ({ ...item, status: 'queued', progress: 0 }));
      return added.length === 0 ? state : [...state, ...added];
    }
    case 'remove':
      // W trakcie wysyłki nie usuwamy (żądanie już leci) — przycisk i tak disabled.
      return state.filter((item) => item.id !== action.id || item.status === 'uploading');
    case 'start':
      return state.map((item) =>
        item.id === action.id && item.status === 'queued'
          ? { ...item, status: 'uploading', progress: 0 }
          : item,
      );
    case 'progress': {
      const progress = Math.min(1, Math.max(0, action.progress));
      return state.map((item) =>
        item.id === action.id && item.status === 'uploading' ? { ...item, progress } : item,
      );
    }
    case 'done':
      return state.map((item) =>
        item.id === action.id
          ? {
              id: item.id,
              name: item.name,
              size: item.size,
              status: 'done',
              progress: 1,
              intakeId: action.intakeId,
              deduplicated: action.deduplicated,
            }
          : item,
      );
    case 'fail':
      return state.map((item) =>
        item.id === action.id
          ? { id: item.id, name: item.name, size: item.size, status: 'failed', progress: 0, error: action.error }
          : item,
      );
    case 'clearFinished':
      return state.some((item) => item.status === 'done')
        ? state.filter((item) => item.status !== 'done')
        : state;
    case 'reset':
      return state.length === 0 ? state : [];
    default:
      return state;
  }
}

/** Następny plik do wysłania (kolejność dodania). */
export function nextQueued(state: readonly FileQueueItem[]): FileQueueItem | undefined {
  return state.find((item) => item.status === 'queued');
}

/** Czy jest cokolwiek do wysłania (submit aktywny). */
export function hasQueued(state: readonly FileQueueItem[]): boolean {
  return state.some((item) => item.status === 'queued');
}
