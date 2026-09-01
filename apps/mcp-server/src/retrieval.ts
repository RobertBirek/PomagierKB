import { hybridSearch as sharedHybridSearch } from '@pomagierkb/shared/answer';
import type { RetrievalMode, RetrievalResult } from '@pomagierkb/shared/answer';
import type { ToolCtx } from './tools/types.js';

/**
 * CIENKI ADAPTER: logika retrievalu hybrydowego (backend-mcp §7.5) mieszka we
 * WSPÓLNYM module packages/shared/src/answer/retrieval.ts (używanym też przez
 * panel-api POST /api/v1/ask). Tu wyłącznie tłumaczenie ToolCtx → AnswerCtx:
 * {db, llm, openspg, log} + allowedNamespaces przekazywane JAWNIE z profilu.
 * Kontrakt narzędzi MCP (sygnatura i typy) — bez zmian.
 */

export type {
  RetrievalHit,
  RetrievalMode,
  RetrievalResult,
  RetrievalSource,
} from '@pomagierkb/shared/answer';

export interface HybridSearchParams {
  query: string;
  namespaces?: string[];
  limit?: number;
  mode?: RetrievalMode;
}

export async function hybridSearch(ctx: ToolCtx, params: HybridSearchParams): Promise<RetrievalResult> {
  return sharedHybridSearch(
    { db: ctx.db, llm: ctx.llm, openspg: ctx.openspg, log: ctx.log },
    { ...params, allowedNamespaces: ctx.allowedNamespaces },
  );
}
