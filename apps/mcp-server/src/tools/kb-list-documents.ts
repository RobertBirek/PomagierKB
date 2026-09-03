import { z } from 'zod';
import { listDocuments } from '@pomagierkb/shared/db';
import { errorResult, parseInput } from './common.js';
import type { KbTool } from './types.js';

/**
 * kb_list_documents — przegląd dokumentów jednej KB (agregacja chunks_mirror po
 * doc_id): tytuł, liczba fragmentów, źródło, data. Uzupełnia kb_list (tylko
 * licznik) o realne „co tu jest"; pełna treść → kb_get_source(docId).
 */

const inputZod = z.strictObject({
  namespace: z.string().min(1),
  q: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).default(0),
});

export const kbListDocumentsTool: KbTool = {
  name: 'kb_list_documents',
  title: 'Lista dokumentów bazy',
  description:
    'Zwraca dokumenty jednej bazy wiedzy (docId, tytuł, liczba fragmentów, źródło) ' +
    'z opcjonalnym filtrem tytułu q i paginacją. Treść dokumentu: kb_get_source(docId).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['namespace'],
    properties: {
      namespace: { type: 'string', minLength: 1 },
      q: { type: 'string', maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['documents', 'total'],
    properties: {
      documents: {
        type: 'array',
        items: {
          type: 'object',
          required: ['docId', 'chunks'],
          properties: {
            docId: { type: 'string' },
            title: { type: 'string' },
            chunks: { type: 'integer' },
            sourceRef: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
      },
      total: { type: 'integer' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  async handler(ctx, input) {
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const { namespace, q, limit, offset } = parsed.data;
    if (!ctx.allowedNamespaces.includes(namespace)) {
      return errorResult(
        'namespace_not_allowed',
        `Namespace poza profilem klucza: ${namespace}. Dostępne: ${ctx.allowedNamespaces.join(', ') || '(brak)'}.`,
      );
    }
    const { items, total } = listDocuments(ctx.db, namespace, {
      ...(q !== undefined ? { q } : {}),
      limit,
      offset,
    });
    const documents = items.map((d) => ({
      docId: d.docId,
      chunks: d.chunks,
      ...(d.title !== null ? { title: d.title } : {}),
      ...(d.sourceRef !== null ? { sourceRef: d.sourceRef } : {}),
      updatedAt: d.updatedAt,
    }));
    const lines = documents.map(
      (d, i) => `${offset + i + 1}. **${d.title ?? d.docId}** — ${d.chunks} fragm.${d.sourceRef !== undefined ? ` (${d.sourceRef})` : ''}`,
    );
    const text =
      documents.length === 0
        ? `Baza ${namespace} nie ma jeszcze dokumentów w indeksie.`
        : `**Dokumenty w ${namespace}** (${offset + 1}–${offset + documents.length} z ${total}):\n\n${lines.join('\n')}`;
    return { structured: { documents, total }, text };
  },
};
