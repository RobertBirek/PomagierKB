import { randomBytes } from 'node:crypto';

/**
 * Stały słownik komunikatów błędów narzędzi MCP (§7.4 + zasada „zero szczegółów
 * upstreamu w odpowiedzi"). Klient dostaje komunikat ze słownika + identyfikator
 * zdarzenia; surowy `err.message` (nazwy hostów wewnętrznych, fragmenty odpowiedzi
 * Javy z OpenSPG, komunikaty dostawcy LLM, SQLITE_BUSY, stacki) trafia WYŁĄCZNIE
 * do logu pino pod tym samym identyfikatorem.
 *
 * Czysta logika — bez frameworka, testowana w test/tool-messages.test.ts.
 */

export type ToolErrorCode =
  | 'namespace_not_allowed'
  | 'upstream_unavailable'
  | 'rate_limited'
  | 'validation'
  | 'forbidden'
  | 'internal';

const TOOL_ERROR_MESSAGES: Record<ToolErrorCode, string> = {
  namespace_not_allowed: 'Żądana baza wiedzy jest poza profilem tego klucza.',
  upstream_unavailable:
    'Usługa zewnętrzna jest chwilowo niedostępna. Spróbuj ponownie za chwilę.',
  rate_limited: 'Limit wywołań wyczerpany. Spróbuj ponownie za chwilę.',
  validation: 'Nieprawidłowe wejście narzędzia.',
  forbidden: 'Brak uprawnień do tej operacji.',
  internal: 'Wewnętrzny błąd narzędzia.',
};

/** Krótki identyfikator zdarzenia — wiąże odpowiedź klienta z wpisem w logu. */
export function newErrorId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Komunikat dla klienta: nazwa narzędzia + tekst ze słownika + identyfikator.
 * NIGDY nie przyjmuje treści pochodzącej z upstreamu.
 */
export function toolErrorText(toolName: string, code: ToolErrorCode, errorId: string): string {
  return `Błąd narzędzia ${toolName}: ${TOOL_ERROR_MESSAGES[code]} (id błędu: ${errorId})`;
}

/** Sam tekst ze słownika (dla wyników budowanych przez handlery narzędzi). */
export function toolErrorMessage(code: ToolErrorCode): string {
  return TOOL_ERROR_MESSAGES[code];
}
