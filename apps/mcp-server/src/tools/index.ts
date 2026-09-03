import type { KbTool } from './types.js';
import { kbSearchTool } from './kb-search.js';
import { kbAnswerTool } from './kb-answer.js';
import { kbListTool } from './kb-list.js';
import { kbGetSourceTool } from './kb-get-source.js';
import { kbListDocumentsTool } from './kb-list-documents.js';
import { kbDraftStatusTool } from './kb-draft-status.js';
import { kbSubmitDraftTool } from './kb-submit-draft.js';
import { kbFeedbackTool } from './kb-feedback.js';

/**
 * Rejestr narzędzi MCP serwowanych przez shell (src/server.ts → src/mcp.ts).
 * Kolejność = kolejność w tools/list; widoczność per profil przycina shell
 * (tools_json ∩ ta lista). Nazwy muszą pokrywać się z KNOWN_MCP_TOOLS w shared.
 */
export const ALL_TOOLS: KbTool[] = [
  kbSearchTool,
  kbAnswerTool,
  kbListTool,
  kbGetSourceTool,
  kbListDocumentsTool,
  kbDraftStatusTool,
  kbSubmitDraftTool,
  kbFeedbackTool,
];

/** Alias zgodności ze stubem shellu. */
export const allTools: KbTool[] = ALL_TOOLS;

export {
  kbSearchTool,
  kbAnswerTool,
  kbListTool,
  kbGetSourceTool,
  kbListDocumentsTool,
  kbDraftStatusTool,
  kbSubmitDraftTool,
  kbFeedbackTool,
};
