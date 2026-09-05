import type { Db } from '../open.js';

/**
 * Krawędzie grafu wiedzy w SQLite (migracja 0006) — jedyne źródło nawigacji
 * grafowej: Neo4j nie ma krawędzi (relacje *RefId to property-stringi).
 * Wypełniane W CAŁOŚCI per namespace przy eksporcie (jak chunks_mirror);
 * BFS jest czystą logiką na posortowanych krawędziach (deterministyczny).
 */

export type EdgeRel = 'in_document' | 'about_topic';

export interface GraphEdge {
  srcId: string;
  rel: EdgeRel;
  dstId: string;
}

export interface NeighborNode {
  id: string;
  /** Dystans BFS od węzła startowego (1..depth). */
  distance: number;
}

export interface NeighborsResult {
  nodes: NeighborNode[];
  edges: GraphEdge[];
}

/** Pełna podmiana krawędzi namespace (transakcyjnie, przy eksporcie). */
export function replaceEdgesForNamespace(db: Db, namespace: string, edges: GraphEdge[]): void {
  const del = db.prepare('DELETE FROM graph_edges WHERE namespace = ?');
  const ins = db.prepare(
    'INSERT OR IGNORE INTO graph_edges (namespace, src_id, rel, dst_id) VALUES (?, ?, ?, ?)',
  );
  const tx = db.transaction(() => {
    del.run(namespace);
    for (const e of edges) ins.run(namespace, e.srcId, e.rel, e.dstId);
  });
  tx.immediate();
}

export type EdgeDirection = 'out' | 'in' | 'both';

/**
 * BFS po krawędziach do głębokości depth (1..3). Kierunek: 'out' = po src→dst,
 * 'in' = po dst→src, 'both' = graf nieskierowany. Zwraca odwiedzone węzły
 * (bez startowego) z dystansem oraz przebyte krawędzie (dedup, sort deterministyczny).
 */
export function neighbors(
  db: Db,
  namespace: string,
  startId: string,
  opts: { depth?: number; direction?: EdgeDirection } = {},
): NeighborsResult {
  const depth = Math.min(Math.max(opts.depth ?? 1, 1), 3);
  const direction = opts.direction ?? 'both';

  const outStmt = db.prepare(
    'SELECT src_id, rel, dst_id FROM graph_edges WHERE namespace = ? AND src_id = ? ORDER BY rel, dst_id',
  );
  const inStmt = db.prepare(
    'SELECT src_id, rel, dst_id FROM graph_edges WHERE namespace = ? AND dst_id = ? ORDER BY rel, src_id',
  );

  const visited = new Map<string, number>([[startId, 0]]);
  const edgeSet = new Map<string, GraphEdge>();
  let frontier = [startId];

  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const rows: { src_id: string; rel: EdgeRel; dst_id: string }[] = [];
      if (direction !== 'in') rows.push(...(outStmt.all(namespace, id) as typeof rows));
      if (direction !== 'out') rows.push(...(inStmt.all(namespace, id) as typeof rows));
      for (const r of rows) {
        edgeSet.set(`${r.src_id}|${r.rel}|${r.dst_id}`, { srcId: r.src_id, rel: r.rel, dstId: r.dst_id });
        const other = r.src_id === id ? r.dst_id : r.src_id;
        if (!visited.has(other)) {
          visited.set(other, d);
          next.push(other);
        }
      }
    }
    frontier = next;
  }

  const nodes = [...visited.entries()]
    .filter(([id]) => id !== startId)
    .map(([id, distance]) => ({ id, distance }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const edges = [...edgeSet.values()].sort(
    (a, b) => a.srcId.localeCompare(b.srcId) || a.dstId.localeCompare(b.dstId),
  );
  return { nodes, edges };
}

/** Czy węzeł w ogóle występuje w krawędziach namespace (ACL-owe istnienie). */
export function nodeExists(db: Db, namespace: string, id: string): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM graph_edges WHERE namespace = ? AND (src_id = ? OR dst_id = ?) LIMIT 1',
      )
      .get(namespace, id, id) !== undefined
  );
}
