import { z } from 'zod';
import { neighbors, nodeExists, type EdgeDirection } from '@pomagierkb/shared/db';
import { errorResult, parseInput } from './common.js';
import type { KbTool, ToolCtx } from './types.js';

/**
 * kb_graph_neighbors — nawigacja po grafie wiedzy (chunk↔dokument↔temat) na
 * tabeli graph_edges w SQLite: krawędzie znamy w 100% z eksportu, a Neo4j ich
 * NIE MA (relacje *RefId to property-stringi — zweryfikowane empirycznie).
 * BFS deterministyczny, depth ≤ 3; tytuły dekorowane z mirrora.
 */

const inputZod = z.strictObject({
  id: z.string().min(1).max(200),
  namespace: z.string().min(1).optional(),
  depth: z.number().int().min(1).max(3).default(1),
  direction: z.enum(['out', 'in', 'both']).default('both'),
});

function resolveNamespace(ctx: ToolCtx, id: string, requested?: string): string | null {
  if (requested !== undefined) return requested;
  const row = ctx.db
    .prepare('SELECT namespace FROM graph_edges WHERE src_id = ? OR dst_id = ? LIMIT 1')
    .get(id, id) as { namespace: string } | undefined;
  return row?.namespace ?? null;
}

export const kbGraphNeighborsTool: KbTool = {
  name: 'kb_graph_neighbors',
  title: 'Sąsiedztwo w grafie wiedzy',
  description:
    'Zwraca sąsiadów encji w grafie wiedzy (fragment↔dokument↔temat) do głębokości 1-3: ' +
    'nodes z dystansem i tytułem oraz edges (in_document/about_topic). ' +
    'Treść węzła: kb_get_source; właściwości: kb_entity_get.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 200 },
      namespace: { type: 'string', minLength: 1 },
      depth: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
      direction: { type: 'string', enum: ['out', 'in', 'both'], default: 'both' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['nodes', 'edges'],
    properties: {
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'distance'],
          properties: {
            id: { type: 'string' },
            distance: { type: 'integer' },
            title: { type: 'string' },
            kind: { type: 'string', enum: ['chunk', 'document', 'topic'] },
          },
        },
      },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          required: ['srcId', 'rel', 'dstId'],
          properties: {
            srcId: { type: 'string' },
            rel: { type: 'string', enum: ['in_document', 'about_topic'] },
            dstId: { type: 'string' },
          },
        },
      },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  async handler(ctx: ToolCtx, input) {
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const { id, depth, direction, namespace: requestedNs } = parsed.data;
    const ns = resolveNamespace(ctx, id, requestedNs);
    if (ns === null || !ctx.allowedNamespaces.includes(ns) || !nodeExists(ctx.db, ns, id)) {
      return errorResult('validation', `Encja nie istnieje w grafie: ${id}`);
    }

    const result = neighbors(ctx.db, ns, id, { depth, direction: direction as EdgeDirection });

    // Dekoracja tytułami z mirrora (chunki po id, dokumenty po doc_id).
    const titles = new Map<string, string>();
    const ids = result.nodes.map((n) => n.id);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      for (const row of ctx.db
        .prepare(`SELECT id, doc_id, title FROM chunks_mirror WHERE namespace = ? AND (id IN (${ph}) OR doc_id IN (${ph}))`)
        .all(ns, ...ids, ...ids) as { id: string; doc_id: string; title: string | null }[]) {
        if (row.title !== null) {
          titles.set(row.id, row.title);
          if (!titles.has(row.doc_id)) titles.set(row.doc_id, row.title);
        }
      }
    }
    const kindOf = (nodeId: string): 'chunk' | 'document' | 'topic' =>
      nodeId.startsWith('CHUNK_') ? 'chunk' : nodeId.startsWith('DOC_') ? 'document' : 'topic';

    const nodes = result.nodes.map((n) => ({
      id: n.id,
      distance: n.distance,
      kind: kindOf(n.id),
      ...(titles.has(n.id) ? { title: titles.get(n.id)! } : {}),
    }));
    const lines = nodes.map(
      (n) => `- [${n.distance}] ${n.kind}: **${n.title ?? n.id}** (${n.id})`,
    );
    return {
      structured: { nodes, edges: result.edges },
      text:
        nodes.length === 0
          ? `Encja ${id} nie ma sąsiadów w zadanym kierunku.`
          : `**Sąsiedztwo ${id}** (depth ${depth}, ${nodes.length} węzłów):\n${lines.join('\n')}`,
    };
  },
};
