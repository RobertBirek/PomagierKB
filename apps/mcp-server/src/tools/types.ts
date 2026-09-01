import type pino from 'pino';
import type { Db, ApiKeyRow, McpProfileRow } from '@pomagierkb/shared/db';
import type { ChatRequest, ChatResult } from '@pomagierkb/shared/llm';
import type { OpenSpgClient } from '@pomagierkb/shared/openspg';
import type { McpConfig } from '../config.js';

/**
 * WSPÓLNY KONTRAKT NARZĘDZI MCP (interfejs między warstwą serwera a narzędziami).
 * Serwer buduje ToolCtx per żądanie (auth → profil → klienci) i woła handler;
 * narzędzia NIE dotykają transportu ani auth.
 *
 * McpConfig jest zdefiniowany w src/config.ts (jedno źródło prawdy o env);
 * tu re-eksportowany, żeby narzędzia importowały wszystko z './types.js'.
 */

export type { Db, ApiKeyRow, McpConfig };

/** Wiersz profilu MCP z DB (alias na typ z packages/shared). */
export type ProfileRow = McpProfileRow;

/** Klient LLM widziany przez narzędzia (chat + embed z packages/shared/llm). */
export interface ToolLlm {
  chat(req: ChatRequest): Promise<ChatResult>;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ToolCtx {
  db: Db;
  profile: ProfileRow;
  keyRow: ApiKeyRow;
  /** namespaces_json profilu ∩ kb_registry WHERE status='active'. */
  allowedNamespaces: string[];
  /** scopes_json klucza (deny-by-default: write wymagany dla kb_submit_draft). */
  scopes: string[];
  /** null = LLM nieskonfigurowany (kb_answer niedostępne, vector channel pomijany). */
  llm: ToolLlm | null;
  /** null = OpenSPG niedostępny (retrieval degraduje się do FTS5). */
  openspg: OpenSpgClient | null;
  config: McpConfig;
  log: pino.Logger;
}

/** Wynik handlera narzędzia: structuredContent + tekst PL (+isError dla błędów). */
export interface ToolResult {
  structured: unknown;
  text: string;
  isError?: boolean;
}

export interface KbTool {
  name: string;
  title: string;
  description: string;
  /** DOKŁADNY JSON Schema z docs/design/backend-mcp.md §7.4. */
  inputSchema: object;
  outputSchema: object;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /**
   * Jawna deklaracja wymogu scope 'write' (bramka w shellu). Brak pola =
   * DENY-BY-DEFAULT: wyprowadzenie z adnotacji (destructiveHint lub
   * readOnlyHint !== true). kb_feedback deklaruje false (PLAN: profil
   * default = odczyt + feedback), kb_submit_draft — true.
   */
  requiresWriteScope?: boolean;
  handler(
    ctx: ToolCtx,
    input: unknown,
  ): Promise<{ structured: unknown; text: string; isError?: boolean }>;
}
