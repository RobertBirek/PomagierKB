import { z } from 'zod';
import { listKbs } from '@pomagierkb/shared/db';
import { hybridSearch } from '../retrieval.js';
import type { RetrievalHit } from '../retrieval.js';
import { errorResult, parseInput, resolveRequestedNamespaces } from './common.js';
import type { KbTool, ToolCtx } from './types.js';

/** kb_search — retrieval hybrydowy (FTS5 + OpenSPG vector/text, fuzja RRF). §7.4/§7.5. */

const inputZod = z.strictObject({
  query: z.string().min(2).max(500),
  namespaces: z.array(z.string()).max(10).optional(),
  limit: z.number().int().min(1).max(20).default(8),
  mode: z.enum(['hybrid', 'text', 'vector']).default('hybrid'),
});

/** Etykieta grafu z prefiksu id eksportera (CHUNK_/DOC_/TOPIC_ — patrz exporter.ts). */
function deriveLabel(hit: RetrievalHit): string | undefined {
  if (hit.namespace === '') return undefined;
  if (hit.id.startsWith('CHUNK_')) return `${hit.namespace}.Chunk`;
  if (hit.id.startsWith('DOC_')) return `${hit.namespace}.ReferenceDocument`;
  if (hit.id.startsWith('TOPIC_')) return `${hit.namespace}.Topic`;
  return undefined;
}

function toMarkdown(results: ReturnType<typeof decorate>, degraded: boolean): string {
  if (results.length === 0) {
    return degraded
      ? 'Nie znalazłem wyników. _Uwaga: tryb awaryjny — przeszukano tylko lokalny indeks (OpenSPG niedostępny)._'
      : 'Nie znalazłem wyników dla tego zapytania.';
  }
  const lines = results.map((r, i) => {
    const title = r.title ?? r.id;
    const snippet = r.snippet.replace(/<\/?b>/g, '**');
    return `${i + 1}. **${title}** — ${r.namespace} (${r.source}, score ${r.score.toFixed(4)})\n   ${snippet}`;
  });
  const footer = degraded
    ? '\n\n_Uwaga: tryb awaryjny — wyniki tylko z lokalnego indeksu FTS (OpenSPG niedostępny lub bez trafień)._'
    : '';
  return `**Wyniki wyszukiwania (${results.length}):**\n\n${lines.join('\n')}${footer}`;
}

function decorate(ctx: ToolCtx, hits: RetrievalHit[]) {
  const kbNames = new Map(listKbs(ctx.db).map((k) => [k.namespace, k.name]));
  return hits.map((h) => {
    const kbName = kbNames.get(h.namespace);
    const label = deriveLabel(h);
    return {
      id: h.id,
      namespace: h.namespace,
      snippet: h.snippet,
      score: h.score,
      source: h.source,
      ...(h.title !== undefined ? { title: h.title } : {}),
      ...(h.sourceRef !== undefined ? { sourceRef: h.sourceRef } : {}),
      ...(kbName !== undefined ? { kbName } : {}),
      ...(label !== undefined ? { label } : {}),
    };
  });
}

export const kbSearchTool: KbTool = {
  name: 'kb_search',
  title: 'Szukaj w bazie wiedzy',
  description:
    'Wyszukiwanie hybrydowe (tekstowe + wektorowe) w dozwolonych bazach wiedzy. ' +
    'Zwraca fragmenty (chunki) z tytułem, snippetem i score; degraded=true oznacza tryb awaryjny (tylko lokalny indeks).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 500 },
      namespaces: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
      mode: { type: 'string', enum: ['hybrid', 'text', 'vector'], default: 'hybrid' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['results', 'degraded'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'namespace', 'score', 'snippet', 'source'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            snippet: { type: 'string' },
            namespace: { type: 'string' },
            kbName: { type: 'string' },
            label: { type: 'string' },
            score: { type: 'number' },
            source: { type: 'string', enum: ['openspg_text', 'openspg_vector', 'fallback_fts'] },
            sourceRef: { type: 'string' },
          },
        },
      },
      tookMs: { type: 'integer' },
      degraded: { type: 'boolean' },
      degradedReasons: {
        type: 'array',
        items: { type: 'string', enum: ['openspg_down', 'openspg_no_hits', 'snippet_only', 'kb_dirty'] },
      },
      matchedRouting: { type: 'array', items: { type: 'string' } },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  async handler(ctx, input) {
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const nsCheck = resolveRequestedNamespaces(ctx, parsed.data.namespaces);
    if (!nsCheck.ok) return nsCheck.result;
    if (nsCheck.namespaces.length === 0) {
      return errorResult('namespace_not_allowed', 'Profil klucza nie ma dostępu do żadnej aktywnej bazy wiedzy.');
    }
    const { results, degraded, degradedReasons, matchedRouting, tookMs } = await hybridSearch(ctx, {
      query: parsed.data.query,
      namespaces: nsCheck.namespaces,
      limit: parsed.data.limit,
      mode: parsed.data.mode,
    });
    const decorated = decorate(ctx, results);
    return {
      structured: { results: decorated, tookMs, degraded, degradedReasons, matchedRouting },
      text: toMarkdown(decorated, degraded),
    };
  },
};
