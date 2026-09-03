import { describe, expect, it } from 'vitest';
import {
  fileQueueReducer,
  hasQueued,
  nextQueued,
  type FileQueueItem,
} from '../src/components/add/fileQueue';

const empty: readonly FileQueueItem[] = [];

function seeded(): readonly FileQueueItem[] {
  return fileQueueReducer(empty, {
    type: 'add',
    items: [
      { id: 'a', name: 'a.pdf', size: 100 },
      { id: 'b', name: 'b.md', size: 200 },
    ],
  });
}

describe('fileQueueReducer()', () => {
  it('add: dodaje jako queued z progress 0, pomija duplikaty id', () => {
    const state = seeded();
    expect(state).toHaveLength(2);
    expect(state[0]).toEqual({ id: 'a', name: 'a.pdf', size: 100, status: 'queued', progress: 0 });
    const again = fileQueueReducer(state, { type: 'add', items: [{ id: 'a', name: 'a.pdf', size: 100 }] });
    expect(again).toBe(state); // brak zmian → ta sama referencja
  });

  it('remove: usuwa queued/done/failed, NIE usuwa uploading', () => {
    let state = seeded();
    state = fileQueueReducer(state, { type: 'start', id: 'a' });
    expect(fileQueueReducer(state, { type: 'remove', id: 'a' })).toHaveLength(2);
    expect(fileQueueReducer(state, { type: 'remove', id: 'b' })).toHaveLength(1);
  });

  it('start: tylko queued → uploading (progress wyzerowany)', () => {
    let state = seeded();
    state = fileQueueReducer(state, { type: 'start', id: 'a' });
    expect(state[0]?.status).toBe('uploading');
    // ponowny start nic nie zmienia (już uploading)
    expect(fileQueueReducer(state, { type: 'start', id: 'a' })[0]?.status).toBe('uploading');
  });

  it('progress: clamp 0..1 i tylko dla uploading', () => {
    let state = seeded();
    state = fileQueueReducer(state, { type: 'start', id: 'a' });
    state = fileQueueReducer(state, { type: 'progress', id: 'a', progress: 0.5 });
    expect(state[0]?.progress).toBe(0.5);
    state = fileQueueReducer(state, { type: 'progress', id: 'a', progress: 7 });
    expect(state[0]?.progress).toBe(1);
    // 'b' nadal queued — progress ignorowany
    state = fileQueueReducer(state, { type: 'progress', id: 'b', progress: 0.9 });
    expect(state[1]?.progress).toBe(0);
  });

  it('done: zapisuje intakeId/deduplicated, kasuje error', () => {
    let state = seeded();
    state = fileQueueReducer(state, { type: 'start', id: 'a' });
    state = fileQueueReducer(state, { type: 'done', id: 'a', intakeId: 'in-1', deduplicated: true });
    expect(state[0]).toEqual({
      id: 'a',
      name: 'a.pdf',
      size: 100,
      status: 'done',
      progress: 1,
      intakeId: 'in-1',
      deduplicated: true,
    });
  });

  it('fail: status failed z komunikatem błędu', () => {
    let state = seeded();
    state = fileQueueReducer(state, { type: 'start', id: 'a' });
    state = fileQueueReducer(state, { type: 'fail', id: 'a', error: 'za duży' });
    expect(state[0]?.status).toBe('failed');
    expect(state[0]?.error).toBe('za duży');
    expect(state[0]?.progress).toBe(0);
  });

  it('clearFinished: usuwa tylko done', () => {
    let state = seeded();
    state = fileQueueReducer(state, { type: 'start', id: 'a' });
    state = fileQueueReducer(state, { type: 'done', id: 'a', intakeId: 'in-1', deduplicated: false });
    const cleared = fileQueueReducer(state, { type: 'clearFinished' });
    expect(cleared.map((i) => i.id)).toEqual(['b']);
    // bez done → ta sama referencja
    expect(fileQueueReducer(cleared, { type: 'clearFinished' })).toBe(cleared);
  });

  it('reset: czyści kolejkę', () => {
    expect(fileQueueReducer(seeded(), { type: 'reset' })).toEqual([]);
    expect(fileQueueReducer(empty, { type: 'reset' })).toBe(empty);
  });
});

describe('nextQueued() / hasQueued()', () => {
  it('zwraca pierwszy queued w kolejności dodania', () => {
    let state = seeded();
    expect(nextQueued(state)?.id).toBe('a');
    expect(hasQueued(state)).toBe(true);
    state = fileQueueReducer(state, { type: 'start', id: 'a' });
    expect(nextQueued(state)?.id).toBe('b');
    state = fileQueueReducer(state, { type: 'start', id: 'b' });
    expect(nextQueued(state)).toBeUndefined();
    expect(hasQueued(state)).toBe(false);
  });
});
