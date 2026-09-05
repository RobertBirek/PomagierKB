import { z } from 'zod';
import { verifyClaim } from '@pomagierkb/shared/answer';
import { appErrorToResult, errorResult, parseInput, resolveRequestedNamespaces } from './common.js';
import type { KbTool } from './types.js';

/**
 * kb_claim_verify — fact-check tezy względem bazy wiedzy (raport MCP §claim_verify):
 * supported / contradicted / insufficient + cytowania. Pipeline współdzielony
 * (shared answer/verify.ts): bramka bez-dowodów bez kosztu LLM, sędzia w
 * wrapUntrusted, insufficient zasila pętlę uczenia (luka wiedzy).
 */

const inputZod = z.strictObject({
  claim: z.string().min(5).max(1000),
  namespaces: z.array(z.string()).max(10).optional(),
});

const STATUS_LABEL: Record<string, string> = {
  supported: 'POTWIERDZONA przez źródła',
  contradicted: 'SPRZECZNA ze źródłami',
  insufficient: 'NIEROZSTRZYGALNA (brak wystarczających źródeł)',
};

export const kbClaimVerifyTool: KbTool = {
  name: 'kb_claim_verify',
  title: 'Zweryfikuj tezę',
  description:
    'Sprawdza pojedynczą tezę względem bazy wiedzy: supported (potwierdzona), ' +
    'contradicted (sprzeczna) lub insufficient (za mało źródeł — rejestruje lukę wiedzy). ' +
    'Zwraca uzasadnienie i cytowania; pełna treść źródła: kb_get_source.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['claim'],
    properties: {
      claim: { type: 'string', minLength: 5, maxLength: 1000 },
      namespaces: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['status', 'explanation', 'citations'],
    properties: {
      status: { type: 'string', enum: ['supported', 'contradicted', 'insufficient'] },
      explanation: { type: 'string' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['n', 'id', 'namespace'],
          properties: {
            n: { type: 'integer' },
            id: { type: 'string' },
            namespace: { type: 'string' },
            title: { type: 'string' },
            snippet: { type: 'string' },
            sourceRef: { type: 'string' },
          },
        },
      },
      degraded: { type: 'boolean' },
      gapRecorded: { type: 'boolean' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },

  async handler(ctx, input) {
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const nsCheck = resolveRequestedNamespaces(ctx, parsed.data.namespaces);
    if (!nsCheck.ok) return nsCheck.result;
    if (nsCheck.namespaces.length === 0) {
      return errorResult('namespace_not_allowed', 'Profil klucza nie ma dostępu do żadnej aktywnej bazy wiedzy.');
    }
    try {
      const result = await verifyClaim(
        { db: ctx.db, llm: ctx.llm, openspg: ctx.openspg, log: ctx.log },
        {
          claim: parsed.data.claim,
          allowedNamespaces: [...ctx.allowedNamespaces],
          namespaces: nsCheck.namespaces,
          source: 'mcp',
          apiKeyId: ctx.keyRow.id,
        },
      );
      const cites = result.citations.map((c) => `[${c.n}] ${c.title ?? c.id}`).join('; ');
      return {
        structured: result,
        text: `**Teza ${STATUS_LABEL[result.status]}.**\n${result.explanation}${cites !== '' ? `\nŹródła: ${cites}` : ''}`,
      };
    } catch (err) {
      const mapped = appErrorToResult(err);
      if (mapped) return mapped;
      throw err;
    }
  },
};
