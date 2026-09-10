/**
 * Wspólny pipeline odpowiedzi (retrieval hybrydowy + odpowiedź z cytowaniami)
 * używany przez mcp-server (kb_search/kb_answer) i panel-api (POST /api/v1/ask).
 * Kontekst zgeneralizowany: {db, llm, openspg, log} + allowedNamespaces JAWNIE.
 */
export {
  hybridSearch,
  DEGRADED_REASONS,
  RETRIEVAL_SOURCES,
  extractExactTokens,
  applyExactTokenBoost,
  EXACT_TOKEN_FTS_POOL,
  stripLiteralQuotes,
  resolveExportId,
  buildOpenSpgTextQuery,
} from './retrieval.js';
export type {
  AnswerCtx,
  AnswerLlm,
  AnswerLog,
  DegradedReason,
  HybridSearchParams,
  RetrievalHit,
  RetrievalMode,
  RetrievalResult,
  RetrievalSource,
} from './retrieval.js';
export {
  evaluateRelevanceGate,
  resolveMinRelevance,
  bestSemanticScore,
  ANSWER_MIN_RELEVANCE_DEFAULT,
  MIN_RELEVANCE_LEGACY_CUTOFF,
} from './gate.js';
export type { GateDecision, GateReason, RelevanceGateInput } from './gate.js';
export {
  answerQuestion,
  toStoredCitations,
  answerSystemPrompt,
  NO_ANSWER_TEXT,
  ANSWER_PROMPT_VERSION,
  UNCITED_PENALTY,
} from './answer.js';
export type {
  AnswerCitation,
  AnswerParams,
  AnswerPhase,
  AnswerResult,
} from './answer.js';
export { rewriteQuery, parseRewriteResponse, clearRewriteCache } from './rewrite.js';
export { rerankHits, cosine, parseLlmOrder } from './rerank.js';
export type { RerankStrategy, RerankOutcome } from './rerank.js';
export {
  answerCacheKey,
  chatConfigFingerprint,
  dataVersion,
  getCachedAnswer,
  putCachedAnswer,
  clearAnswerCache,
} from './cache.js';
export type { AnswerCacheOptions } from './cache.js';
export { verifyClaim, parseVerdict } from './verify.js';
export type { ClaimStatus, VerifyClaimResult, VerifyClaimParams } from './verify.js';
export { extractClaims, uncitedShare } from './claims.js';
export type { AnswerClaim } from './claims.js';
