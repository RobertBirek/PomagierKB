import { z } from 'zod';
import { getKb } from '@pomagierkb/shared/db';
import type { KbRow } from '@pomagierkb/shared/db';
import { parseInput } from './common.js';
import type { KbTool, ToolCtx } from './types.js';

/** kb_list — rejestr KB przycięty do namespaces profilu (+documentCount z manifestów). */

const inputZod = z.strictObject({});

/** Ostatni udany eksport (manifesty w DB) → liczba dokumentów; brak → undefined. */
function documentCount(ctx: ToolCtx, namespace: string): number | undefined {
  try {
    const row = ctx.db
      .prepare(
        `SELECT doc_count FROM export_runs
         WHERE namespace = ? AND status = 'success' AND doc_count IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(namespace) as { doc_count: number } | undefined;
    return row?.doc_count;
  } catch {
    return undefined;
  }
}

function toEntry(ctx: ToolCtx, row: KbRow) {
  const count = documentCount(ctx, row.namespace);
  return {
    namespace: row.namespace,
    name: row.name,
    status: row.status,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.description !== '' ? { description: row.description } : {}),
    ...(count !== undefined ? { documentCount: count } : {}),
  };
}

export const kbListTool: KbTool = {
  name: 'kb_list',
  title: 'Lista baz wiedzy',
  description: 'Zwraca bazy wiedzy dostępne dla tego klucza (namespace, nazwa, status, liczba dokumentów).',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['kbs'],
    properties: {
      kbs: {
        type: 'array',
        items: {
          type: 'object',
          required: ['namespace', 'name', 'status'],
          properties: {
            namespace: { type: 'string' },
            name: { type: 'string' },
            projectId: { type: 'integer' },
            status: { type: 'string' },
            description: { type: 'string' },
            documentCount: { type: 'integer' },
          },
        },
      },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  async handler(ctx, input) {
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const kbs = ctx.allowedNamespaces
      .map((ns) => getKb(ctx.db, ns))
      .filter((row): row is KbRow => row !== null)
      .map((row) => toEntry(ctx, row));
    const text =
      kbs.length === 0
        ? 'Ten klucz nie ma dostępu do żadnej aktywnej bazy wiedzy.'
        : `**Dostępne bazy wiedzy (${kbs.length}):**\n\n` +
          kbs
            .map((k) => {
              const docs = k.documentCount !== undefined ? `, dokumentów: ${k.documentCount}` : '';
              const desc = k.description !== undefined ? ` — ${k.description}` : '';
              return `- **${k.namespace}** (${k.name}${docs})${desc}`;
            })
            .join('\n');
    return { structured: { kbs }, text };
  },
};
