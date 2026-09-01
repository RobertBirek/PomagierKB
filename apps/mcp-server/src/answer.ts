import { answerQuestion as sharedAnswerQuestion } from '@pomagierkb/shared/answer';
import type { AnswerResult } from '@pomagierkb/shared/answer';
import type { ToolCtx } from './tools/types.js';

/**
 * CIENKI ADAPTER: pipeline kb_answer (backend-mcp §7.6 + PLAN) mieszka we
 * WSPÓLNYM module packages/shared/src/answer/answer.ts (używanym też przez
 * panel-api POST /api/v1/ask). Tu wyłącznie tłumaczenie ToolCtx → AnswerCtx
 * + atrybucja MCP: source:'mcp', apiKeyId z klucza, allowedNamespaces z profilu.
 * Zachowanie narzędzia kb_answer — 1:1 bez zmian.
 */

export { NO_ANSWER_TEXT } from '@pomagierkb/shared/answer';
export type { AnswerCitation, AnswerResult } from '@pomagierkb/shared/answer';

export interface AnswerParams {
  question: string;
  namespaces?: string[];
  maxSources?: number;
  language?: 'pl' | 'en';
}

export async function answerQuestion(ctx: ToolCtx, params: AnswerParams): Promise<AnswerResult> {
  return sharedAnswerQuestion(
    { db: ctx.db, llm: ctx.llm, openspg: ctx.openspg, log: ctx.log },
    {
      ...params,
      allowedNamespaces: ctx.allowedNamespaces,
      source: 'mcp',
      apiKeyId: ctx.keyRow.id,
    },
  );
}
