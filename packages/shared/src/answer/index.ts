/**
 * Wspólny pipeline odpowiedzi (retrieval hybrydowy + odpowiedź z cytowaniami)
 * używany przez mcp-server (kb_search/kb_answer) i panel-api (POST /api/v1/ask).
 * Kontekst zgeneralizowany: {db, llm, openspg, log} + allowedNamespaces JAWNIE.
 */
export { hybridSearch, stripLiteralQuotes } from './retrieval.js';
export type {
  AnswerCtx,
  AnswerLlm,
  AnswerLog,
  HybridSearchParams,
  RetrievalHit,
  RetrievalMode,
  RetrievalResult,
  RetrievalSource,
} from './retrieval.js';
export { answerQuestion, NO_ANSWER_TEXT } from './answer.js';
export type {
  AnswerCitation,
  AnswerParams,
  AnswerPhase,
  AnswerResult,
} from './answer.js';
export { rewriteQuery, parseRewriteResponse, clearRewriteCache } from './rewrite.js';
export { rerankHits, cosine, parseLlmOrder } from './rerank.js';
export type { RerankStrategy, RerankOutcome } from './rerank.js';
export { answerCacheKey, dataVersion, getCachedAnswer, putCachedAnswer, clearAnswerCache } from './cache.js';
export { verifyClaim, parseVerdict } from './verify.js';
export type { ClaimStatus, VerifyClaimResult, VerifyClaimParams } from './verify.js';
export { extractClaims } from './claims.js';
export type { AnswerClaim } from './claims.js';
