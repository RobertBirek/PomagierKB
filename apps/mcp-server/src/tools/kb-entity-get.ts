import { z } from 'zod';
import { getChunk, getKb } from '@pomagierkb/shared/db';
import { querySpgType } from '@pomagierkb/shared/openspg';
import { errorResult, parseInput } from './common.js';
import type { KbTool, ToolCtx } from './types.js';

/**
 * kb_entity_get — autorytatywny stan encji Z GRAFU (query/spgType, zweryfikowane
 * w boju) z sanitizacją po stronie shared (bez pól wektorowych, bez literalnych
 * cudzysłowów buildera). Fallback: mirror SQLite z degraded:true (wzorzec retrieval).
 * ACL: namespace spoza profilu → ten sam błąd co nieistniejące id (bez wyroczni).
 */

const inputZod = z.strictObject({
  id: z.string().min(1).max(200),
  namespace: z.string().min(1).optional(),
});

const TYPE_BY_PREFIX: [string, string][] = [
  ['CHUNK_', 'Chunk'],
  ['DOC_', 'ReferenceDocument'],
  ['TOPIC_', 'Topic'],
];

function typeForId(id: string): string | null {
  for (const [prefix, type] of TYPE_BY_PREFIX) if (id.startsWith(prefix)) return type;
  return null;
}

/** Namespace encji: parametr, a bez niego lookup w mirrorze/krawędziach. */
function resolveNamespace(ctx: ToolCtx, id: string, requested?: string): string | null {
  if (requested !== undefined) return requested;
  const mirrorRow = ctx.db
    .prepare('SELECT namespace FROM chunks_mirror WHERE id = ? OR doc_id = ? LIMIT 1')
    .get(id, id) as { namespace: string } | undefined;
  if (mirrorRow !== undefined) return mirrorRow.namespace;
  const edgeRow = ctx.db
    .prepare('SELECT namespace FROM graph_edges WHERE src_id = ? OR dst_id = ? LIMIT 1')
    .get(id, id) as { namespace: string } | undefined;
  return edgeRow?.namespace ?? null;
}

function notFound(id: string): ReturnType<typeof errorResult> {
  return errorResult('validation', `Encja nie istnieje: ${id}`);
}

export const kbEntityGetTool: KbTool = {
  name: 'kb_entity_get',
  title: 'Pobierz encję grafu',
  description:
    'Zwraca właściwości encji grafu wiedzy (CHUNK_*/DOC_*/TOPIC_*) wprost z OpenSPG ' +
    '(stan autorytatywny); przy niedostępności grafu fallback do lokalnego indeksu ' +
    'z degraded:true. Sąsiedztwo: kb_graph_neighbors; pełna treść: kb_get_source.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 200 },
      namespace: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['id', 'namespace', 'spgType', 'properties', 'degraded'],
    properties: {
      id: { type: 'string' },
      namespace: { type: 'string' },
      spgType: { type: 'string' },
      properties: { type: 'object' },
      degraded: { type: 'boolean' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  async handler(ctx: ToolCtx, input) {
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const { id, namespace: requestedNs } = parsed.data;
    const entityType = typeForId(id);
    if (entityType === null) return notFound(id);
    const ns = resolveNamespace(ctx, id, requestedNs);
    if (ns === null || !ctx.allowedNamespaces.includes(ns)) return notFound(id);

    // PRIMARY: graf (query/spgType) — wymaga projectId z rejestru.
    const kb = getKb(ctx.db, ns);
    if (ctx.openspg !== null && kb?.project_id != null) {
      try {
        const entities = await querySpgType(ctx.openspg, {
          projectId: kb.project_id,
          spgType: `${ns}.${entityType}`,
          ids: [id],
        });
        const entity = entities[0];
        if (entity !== undefined) {
          const structured = {
            id: entity.id,
            namespace: ns,
            spgType: entity.spgType,
            properties: entity.properties,
            degraded: false,
          };
          const name = entity.properties['name'] ?? id;
          return {
            structured,
            text: `**${name}** (${entity.spgType})\n${Object.entries(entity.properties)
              .filter(([k]) => k !== 'name')
              .slice(0, 12)
              .map(([k, v]) => `- ${k}: ${v.length > 200 ? `${v.slice(0, 200)}…` : v}`)
              .join('\n')}`,
          };
        }
      } catch (err) {
        ctx.log.warn(
          { id, err: err instanceof Error ? err.message : String(err) },
          'kb_entity_get: query/spgType zawiodło — fallback do mirrora',
        );
      }
    }

    // FALLBACK: mirror SQLite (chunki mają pełny wiersz; doc/topic — złożenie minimalne).
    if (id.startsWith('CHUNK_')) {
      const row = getChunk(ctx.db, id);
      if (row === null || row.namespace !== ns) return notFound(id);
      const properties: Record<string, string> = {
        name: row.title ?? id,
        content: row.content,
        sourceDocumentRefId: row.doc_id,
        ...(row.section_heading !== null ? { sectionHeading: row.section_heading } : {}),
        ...(row.source_ref !== null ? { sourceUrl: row.source_ref } : {}),
      };
      return {
        structured: { id, namespace: ns, spgType: `${ns}.${entityType}`, properties, degraded: true },
        text: `**${properties['name']}** (${ns}.${entityType}) — _stan z lokalnego indeksu (graf niedostępny)_`,
      };
    }
    const docRow = ctx.db
      .prepare('SELECT title, source_ref, COUNT(*) AS chunks FROM chunks_mirror WHERE doc_id = ? AND namespace = ?')
      .get(id, ns) as { title: string | null; source_ref: string | null; chunks: number } | undefined;
    if (docRow === undefined || docRow.chunks === 0) return notFound(id);
    const properties: Record<string, string> = {
      name: docRow.title ?? id,
      chunkCount: String(docRow.chunks),
      ...(docRow.source_ref !== null ? { sourceUrl: docRow.source_ref } : {}),
    };
    return {
      structured: { id, namespace: ns, spgType: `${ns}.${entityType}`, properties, degraded: true },
      text: `**${properties['name']}** (${ns}.${entityType}) — _stan z lokalnego indeksu (graf niedostępny)_`,
    };
  },
};
