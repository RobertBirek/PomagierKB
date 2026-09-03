import { z } from 'zod';
import { getChunk, getDocumentChunks, type ChunkMirrorRow } from '@pomagierkb/shared/db';
import { errorResult, parseInput } from './common.js';
import type { KbTool, ToolCtx } from './types.js';

/**
 * kb_get_source — pełna treść źródła po id z cytowania/kb_search (chunks_mirror).
 * Domyka największą lukę agenta: dotąd widział tylko 300-znakowe snippety.
 * - CHUNK_* → pojedynczy chunk + sąsiedzi prev/next (sufiks _NNN eksportera),
 * - DOC_*   → konkatenacja wszystkich chunków dokumentu z nagłówkami sekcji.
 * ACL: namespace spoza profilu → not-found-owe 'validation' (bez wyroczni istnienia).
 */

const MAX_CHARS_DEFAULT = 20_000;
const MAX_CHARS_CAP = 50_000;

const inputZod = z.strictObject({
  id: z.string().min(1).max(200),
  maxChars: z.number().int().min(1000).max(MAX_CHARS_CAP).default(MAX_CHARS_DEFAULT),
});

/** Sąsiedzi chunka po sufiksie _NNN (kolejność sekcji z eksportera). */
function neighborIds(id: string): { prev?: string; next?: string } {
  const m = /^(.*_)(\d{3})$/.exec(id);
  if (!m) return {};
  const n = Number(m[2]);
  const pad = (x: number): string => String(x).padStart(3, '0');
  return {
    ...(n > 1 ? { prev: `${m[1]}${pad(n - 1)}` } : {}),
    next: `${m[1]}${pad(n + 1)}`,
  };
}

function notFound(id: string): ReturnType<typeof errorResult> {
  return errorResult('validation', `Źródło nie istnieje: ${id}`);
}

function assemble(
  chunks: ChunkMirrorRow[],
  maxChars: number,
): { content: string; truncated: boolean; nextChunkId?: string } {
  let content = '';
  for (const [i, c] of chunks.entries()) {
    const heading = c.section_heading !== null && c.section_heading !== '' ? `## ${c.section_heading}\n` : '';
    const piece = (content === '' ? '' : '\n\n') + heading + c.content;
    if (content.length + piece.length > maxChars) {
      return {
        content: content === '' ? piece.slice(0, maxChars) : content,
        truncated: true,
        ...(chunks[i] !== undefined ? { nextChunkId: chunks[i].id } : {}),
      };
    }
    content += piece;
  }
  return { content, truncated: false };
}

export const kbGetSourceTool: KbTool = {
  name: 'kb_get_source',
  title: 'Pobierz treść źródła',
  description:
    'Zwraca PEŁNĄ treść źródła po id z cytowania kb_answer lub wyniku kb_search: ' +
    'id CHUNK_* = jeden fragment (+ id sąsiadów prev/next), id DOC_* = cały dokument ' +
    '(sekcje scalone; przy przekroczeniu maxChars pole truncated i nextChunkId do kontynuacji).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 200 },
      maxChars: { type: 'integer', minimum: 1000, maximum: MAX_CHARS_CAP, default: MAX_CHARS_DEFAULT },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['id', 'namespace', 'content', 'truncated'],
    properties: {
      id: { type: 'string' },
      docId: { type: 'string' },
      namespace: { type: 'string' },
      title: { type: 'string' },
      sourceRef: { type: 'string' },
      content: { type: 'string' },
      truncated: { type: 'boolean' },
      nextChunkId: { type: 'string' },
      prevChunkId: { type: 'string' },
      chunkCount: { type: 'integer' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  async handler(ctx: ToolCtx, input) {
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const { id, maxChars } = parsed.data;
    const allowed = new Set(ctx.allowedNamespaces);

    if (id.startsWith('CHUNK_')) {
      const chunk = getChunk(ctx.db, id);
      if (chunk === null || !allowed.has(chunk.namespace)) return notFound(id);
      const siblings = getDocumentChunks(ctx.db, chunk.doc_id);
      const siblingIds = new Set(siblings.map((s) => s.id));
      const { prev, next } = neighborIds(id);
      const truncated = chunk.content.length > maxChars;
      const content = truncated ? chunk.content.slice(0, maxChars) : chunk.content;
      const structured = {
        id,
        docId: chunk.doc_id,
        namespace: chunk.namespace,
        content,
        truncated,
        chunkCount: siblings.length,
        ...(chunk.title !== null ? { title: chunk.title } : {}),
        ...(chunk.source_ref !== null ? { sourceRef: chunk.source_ref } : {}),
        ...(prev !== undefined && siblingIds.has(prev) ? { prevChunkId: prev } : {}),
        ...(next !== undefined && siblingIds.has(next) ? { nextChunkId: next } : {}),
      };
      const heading = chunk.section_heading !== null ? ` (${chunk.section_heading})` : '';
      return {
        structured,
        text: `**${chunk.title ?? chunk.doc_id}**${heading} — ${chunk.namespace}\n\n${content}`,
      };
    }

    if (id.startsWith('DOC_')) {
      const chunks = getDocumentChunks(ctx.db, id);
      const first = chunks[0];
      if (first === undefined || !allowed.has(first.namespace)) return notFound(id);
      const { content, truncated, nextChunkId } = assemble(chunks, maxChars);
      const structured = {
        id,
        docId: id,
        namespace: first.namespace,
        content,
        truncated,
        chunkCount: chunks.length,
        ...(first.title !== null ? { title: first.title } : {}),
        ...(first.source_ref !== null ? { sourceRef: first.source_ref } : {}),
        ...(nextChunkId !== undefined ? { nextChunkId } : {}),
      };
      const note = truncated
        ? `\n\n_(treść przycięta do ${maxChars} znaków — kontynuacja od ${nextChunkId ?? 'kolejnego fragmentu'})_`
        : '';
      return {
        structured,
        text: `**${first.title ?? id}** — ${first.namespace} (${chunks.length} fragmentów)\n\n${content}${note}`,
      };
    }

    return notFound(id);
  },
};
