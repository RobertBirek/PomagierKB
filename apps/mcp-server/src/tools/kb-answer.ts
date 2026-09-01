import { z } from 'zod';
import { answerQuestion } from '../answer.js';
import type { AnswerResult } from '../answer.js';
import { appErrorToResult, errorResult, parseInput, resolveRequestedNamespaces } from './common.js';
import type { KbTool } from './types.js';

/** kb_answer — odpowiedź z cytowaniami wg pipeline'u §7.6 (bramka odmowy przed LLM). */

const inputZod = z.strictObject({
  question: z.string().min(5).max(2000),
  namespaces: z.array(z.string()).max(10).optional(),
  maxSources: z.number().int().min(1).max(10).default(6),
  language: z.enum(['pl', 'en']).default('pl'),
});

function toMarkdown(res: AnswerResult): string {
  const parts: string[] = [res.answer];
  if (res.citations.length > 0) {
    const lines = res.citations.map((c) => {
      const title = c.title ?? c.id;
      const ref = c.sourceRef !== undefined ? ` — ${c.sourceRef}` : '';
      return `[${c.n}] ${title} (${c.namespace})${ref}`;
    });
    parts.push(`**Źródła:**\n${lines.join('\n')}`);
  }
  const meta = `_pewność: ${res.confidence.toFixed(2)}${res.degraded ? ', tryb awaryjny wyszukiwania' : ''}${res.gapRecorded ? ', zapisano lukę wiedzy' : ''}_`;
  parts.push(meta);
  if (res.warnings.length > 0) parts.push(res.warnings.map((w) => `_Uwaga: ${w}_`).join('\n'));
  return parts.join('\n\n');
}

export const kbAnswerTool: KbTool = {
  name: 'kb_answer',
  title: 'Zapytaj bazę wiedzy',
  description:
    'Odpowiada na pytanie WYŁĄCZNIE na podstawie treści z dozwolonych baz wiedzy, z cytowaniami [n]. ' +
    'Gdy retrieval jest słaby, uczciwie odmawia (noAnswer) i rejestruje lukę wiedzy zamiast zmyślać.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['question'],
    properties: {
      question: { type: 'string', minLength: 5, maxLength: 2000 },
      namespaces: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      maxSources: { type: 'integer', minimum: 1, maximum: 10, default: 6 },
      language: { type: 'string', enum: ['pl', 'en'], default: 'pl' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['answer', 'citations', 'confidence', 'gapRecorded', 'answerId'],
    properties: {
      answer: { type: 'string', description: 'Markdown z cytowaniami [1],[2]' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['n', 'id', 'namespace'],
          properties: {
            n: { type: 'integer' },
            id: { type: 'string' },
            title: { type: 'string' },
            namespace: { type: 'string' },
            snippet: { type: 'string' },
            sourceRef: { type: 'string' },
          },
        },
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      model: { type: 'string' },
      degraded: { type: 'boolean' },
      gapRecorded: { type: 'boolean' },
      answerId: { type: 'string' },
      noAnswer: { type: 'boolean' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  async handler(ctx, input) {
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const nsCheck = resolveRequestedNamespaces(ctx, parsed.data.namespaces);
    if (!nsCheck.ok) return nsCheck.result;
    if (ctx.llm === null) {
      return errorResult(
        'upstream_unavailable',
        'LLM nie jest skonfigurowany (Ustawienia → LLM) — kb_answer jest niedostępne.',
      );
    }
    let res: AnswerResult;
    try {
      res = await answerQuestion(ctx, {
        question: parsed.data.question,
        namespaces: nsCheck.namespaces,
        maxSources: parsed.data.maxSources,
        language: parsed.data.language,
      });
    } catch (err) {
      const mapped = appErrorToResult(err);
      if (mapped) return mapped;
      throw err;
    }
    return {
      structured: {
        answer: res.answer,
        citations: res.citations,
        confidence: res.confidence,
        ...(res.model !== null ? { model: res.model } : {}),
        degraded: res.degraded,
        gapRecorded: res.gapRecorded,
        answerId: res.answerId,
        noAnswer: res.noAnswer,
        warnings: res.warnings,
      },
      text: toMarkdown(res),
    };
  },
};
