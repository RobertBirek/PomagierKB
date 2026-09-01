import { z } from 'zod';
import { AppError } from '@pomagierkb/shared/errors';
import type { ToolCtx } from './types.js';

/** Wspólne pomocniki handlerów narzędzi MCP (walidacja, namespaces, mapowanie błędów). */

/** Kształt wyniku handlera (zgodny z KbTool.handler). */
export interface ToolOutcome {
  structured: unknown;
  text: string;
  isError?: boolean;
}

/**
 * Kody błędów narzędzi (§7.4): błąd = wynik z isError:true + structuredContent:{errorCode},
 * nigdy błąd protokołu (ten zarezerwowany dla auth/transportu).
 */
export type ToolErrorCode =
  | 'namespace_not_allowed'
  | 'upstream_unavailable'
  | 'rate_limited'
  | 'validation'
  | 'forbidden';

export function errorResult(errorCode: ToolErrorCode, text: string): ToolOutcome {
  return { structured: { errorCode }, text, isError: true };
}

/** Walidacja wejścia zodem; błąd → wynik 'validation' z czytelnym komunikatem PL. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { ok: true; data: z.output<S> } | { ok: false; result: ToolOutcome } {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, result: errorResult('validation', `Nieprawidłowe wejście narzędzia: ${msg}`) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Parametr namespaces przycinany do zbioru profilu (§7.3): nadmiarowe →
 * błąd namespace_not_allowed w wyniku narzędzia; brak/pusty = wszystkie dozwolone.
 */
export function resolveRequestedNamespaces(
  ctx: ToolCtx,
  requested: string[] | undefined,
): { ok: true; namespaces: string[] } | { ok: false; result: ToolOutcome } {
  if (!requested || requested.length === 0) return { ok: true, namespaces: [...ctx.allowedNamespaces] };
  const allowed = new Set(ctx.allowedNamespaces);
  const bad = requested.filter((ns) => !allowed.has(ns));
  if (bad.length > 0) {
    return {
      ok: false,
      result: errorResult(
        'namespace_not_allowed',
        `Namespace poza profilem klucza: ${bad.join(', ')}. Dostępne: ${ctx.allowedNamespaces.join(', ') || '(brak)'}.`,
      ),
    };
  }
  return { ok: true, namespaces: [...new Set(requested)] };
}

/** AppError z repozytoriów/klientów → wynik narzędzia; inne błędy → null (rethrow u wołającego). */
export function appErrorToResult(err: unknown): ToolOutcome | null {
  if (!(err instanceof AppError)) return null;
  switch (err.code) {
    case 'rate_limited':
      return errorResult('rate_limited', `Limit wyczerpany: ${err.message}`);
    case 'upstream_error':
    case 'upstream_timeout':
    case 'not_ready':
      return errorResult('upstream_unavailable', `Usługa zewnętrzna niedostępna: ${err.message}`);
    case 'forbidden':
    case 'unauthorized':
      return errorResult('forbidden', err.message);
    default:
      return errorResult('validation', err.message);
  }
}
