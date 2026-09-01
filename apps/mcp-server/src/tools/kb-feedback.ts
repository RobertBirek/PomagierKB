import { z } from 'zod';
import { appendAudit } from '@pomagierkb/shared/audit';
import { recordFeedback } from '@pomagierkb/shared/db';
import { appErrorToResult, parseInput } from './common.js';
import type { KbTool } from './types.js';

/**
 * kb_feedback — 👍/👎 do odpowiedzi kb_answer (po answerId). Kciuk w dół tworzy
 * lukę wiedzy (source 'feedback') przez repo answersFeedback — pętla uczenia.
 */

const inputZod = z.strictObject({
  answerId: z.string(),
  verdict: z.enum(['up', 'down']),
  comment: z.string().max(2000).optional(),
});

export const kbFeedbackTool: KbTool = {
  name: 'kb_feedback',
  title: 'Oceń odpowiedź',
  description:
    'Rejestruje ocenę odpowiedzi kb_answer (verdict up/down po answerId). ' +
    'Ocena negatywna tworzy lukę wiedzy do uzupełnienia przez zespół.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['answerId', 'verdict'],
    properties: {
      answerId: { type: 'string' },
      verdict: { type: 'string', enum: ['up', 'down'] },
      comment: { type: 'string', maxLength: 2000 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['ok', 'gapCreated'],
    properties: {
      ok: { type: 'boolean' },
      gapCreated: { type: 'boolean' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // PLAN (Faza 5): feedback dostępny dla kluczy read — profil seed 'default' to
  // „odczyt + feedback”. Zapisuje TYLKO ocenę/lukę, nigdy treść KB.
  requiresWriteScope: false,

  async handler(ctx, input) {
    const parsed = parseInput(inputZod, input);
    if (!parsed.ok) return parsed.result;
    const { answerId, verdict, comment } = parsed.data;
    try {
      const { gap } = recordFeedback(ctx.db, answerId, verdict, comment ?? null, ctx.keyRow.id);
      appendAudit(ctx.db, {
        actor: ctx.keyRow.id,
        actorType: 'api_key',
        action: 'mcp.feedback',
        resourceType: 'answer',
        resourceId: answerId,
        metadata: { verdict, hasComment: comment !== undefined },
      });
      const gapCreated = gap !== null;
      const text =
        verdict === 'up'
          ? 'Dziękuję — zapisałem pozytywną ocenę odpowiedzi.'
          : gapCreated
            ? 'Dziękuję — zapisałem negatywną ocenę i zarejestrowałem lukę wiedzy do uzupełnienia.'
            : 'Dziękuję — zapisałem negatywną ocenę odpowiedzi.';
      return { structured: { ok: true, gapCreated }, text };
    } catch (err) {
      const mapped = appErrorToResult(err);
      if (mapped) return mapped;
      throw err;
    }
  },
};
