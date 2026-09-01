/**
 * Wspólny pipeline odpowiedzi (retrieval hybrydowy + odpowiedź z cytowaniami)
 * używany przez mcp-server (kb_search/kb_answer) i panel-api (POST /api/v1/ask).
 * Kontekst zgeneralizowany: {db, llm, openspg, log} + allowedNamespaces JAWNIE.
 */
export { hybridSearch } from './retrieval.js';
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
