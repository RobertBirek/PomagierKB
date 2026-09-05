import { describe, expect, it } from 'vitest';
import { neighbors, nodeExists, replaceEdgesForNamespace } from '../src/db/index.js';
import { testDb } from './helpers.js';

/** Krawędzie grafu w SQLite (migracja 0006) — BFS deterministyczny. */

function seed(db: ReturnType<typeof testDb>): void {
  replaceEdgesForNamespace(db, 'KbA', [
    { srcId: 'CHUNK_d1_001', rel: 'in_document', dstId: 'DOC_d1' },
    { srcId: 'CHUNK_d1_002', rel: 'in_document', dstId: 'DOC_d1' },
    { srcId: 'DOC_d1', rel: 'about_topic', dstId: 'TOPIC_LED' },
    { srcId: 'DOC_d2', rel: 'about_topic', dstId: 'TOPIC_LED' },
  ]);
}

describe('graph_edges', () => {
  it('BFS depth 1: chunk widzi swój dokument; depth 2 dosięga tematu i rodzeństwa', () => {
    const db = testDb();
    seed(db);
    const d1 = neighbors(db, 'KbA', 'CHUNK_d1_001', { depth: 1 });
    expect(d1.nodes).toEqual([{ id: 'DOC_d1', distance: 1 }]);

    const d2 = neighbors(db, 'KbA', 'CHUNK_d1_001', { depth: 2 });
    expect(d2.nodes.map((n) => n.id)).toEqual(['DOC_d1', 'CHUNK_d1_002', 'TOPIC_LED']);
    expect(d2.nodes.find((n) => n.id === 'TOPIC_LED')?.distance).toBe(2);
  });

  it('depth 3 przez wspólny temat dociera do drugiego dokumentu; kierunki out/in', () => {
    const db = testDb();
    seed(db);
    const d3 = neighbors(db, 'KbA', 'CHUNK_d1_001', { depth: 3 });
    expect(d3.nodes.map((n) => n.id)).toContain('DOC_d2');

    const out = neighbors(db, 'KbA', 'DOC_d1', { depth: 1, direction: 'out' });
    expect(out.nodes.map((n) => n.id)).toEqual(['TOPIC_LED']);
    const incoming = neighbors(db, 'KbA', 'DOC_d1', { depth: 1, direction: 'in' });
    expect(incoming.nodes.map((n) => n.id)).toEqual(['CHUNK_d1_001', 'CHUNK_d1_002']);
  });

  it('replaceEdgesForNamespace podmienia w całości; nodeExists; izolacja namespace', () => {
    const db = testDb();
    seed(db);
    expect(nodeExists(db, 'KbA', 'TOPIC_LED')).toBe(true);
    expect(nodeExists(db, 'KbB', 'TOPIC_LED')).toBe(false);
    replaceEdgesForNamespace(db, 'KbA', [{ srcId: 'CHUNK_x_001', rel: 'in_document', dstId: 'DOC_x' }]);
    expect(nodeExists(db, 'KbA', 'TOPIC_LED')).toBe(false);
    expect(neighbors(db, 'KbA', 'CHUNK_x_001', { depth: 1 }).nodes).toEqual([
      { id: 'DOC_x', distance: 1 },
    ]);
  });
});
