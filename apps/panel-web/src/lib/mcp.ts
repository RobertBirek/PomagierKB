/**
 * Czysta logika strony /mcp (bez Reacta/DOM — testy w test/mcp.test.ts):
 * - walidacja formularza profilu MCP (tools niepuste i znane, namespaces z listy),
 * - status klucza API jako plakietka (active/expiring/expired/revoked),
 * - liczenie dni do wygaśnięcia.
 * Kontrakt z apps/panel-api/src/routes/mcp-admin.ts + services/mcp-admin.ts.
 */
import type { PlKey } from '../i18n/pl';
import type { BadgeVariant } from './status';

/** Znane narzędzia MCP — lustro KNOWN_MCP_TOOLS z packages/shared (backend waliduje enum). */
export const MCP_TOOLS = ['kb_search', 'kb_answer', 'kb_list', 'kb_submit_draft', 'kb_feedback'] as const;
export type McpToolName = (typeof MCP_TOOLS)[number];

/** Wzorzec id profilu — lustro pattern z routes/mcp-admin.ts. */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ProfileFormInput {
  /** Id profilu (tylko przy tworzeniu; przy edycji przekazuj istniejące). */
  id: string;
  name: string;
  tools: readonly string[];
  /** true = profil widzi wszystkie bazy (namespaces: null w API). */
  allNamespaces: boolean;
  /** Wybrane namespaces (istotne tylko gdy allNamespaces === false). */
  namespaces: readonly string[];
}

export type ProfileFormErrorField = 'id' | 'name' | 'tools' | 'namespaces';

export interface ProfileFormResult {
  ok: boolean;
  errors: ProfileFormErrorField[];
}

/**
 * Walidacja formularza profilu MCP:
 * - id zgodne z wzorcem backendu (małe litery/cyfry/myślniki, max 64);
 * - name niepuste po trim;
 * - tools: co najmniej jedno i wyłącznie ze znanej listy;
 * - namespaces: przy allNamespaces=false — niepuste i wyłącznie z listy istniejących KB.
 */
export function validateProfileForm(
  input: ProfileFormInput,
  knownNamespaces: readonly string[],
): ProfileFormResult {
  const errors: ProfileFormErrorField[] = [];
  if (!PROFILE_ID_RE.test(input.id)) errors.push('id');
  if (input.name.trim() === '') errors.push('name');
  const knownTools: readonly string[] = MCP_TOOLS;
  if (input.tools.length === 0 || input.tools.some((tool) => !knownTools.includes(tool))) {
    errors.push('tools');
  }
  if (!input.allNamespaces) {
    if (input.namespaces.length === 0 || input.namespaces.some((ns) => !knownNamespaces.includes(ns))) {
      errors.push('namespaces');
    }
  }
  return { ok: errors.length === 0, errors };
}

const DAY_MS = 86_400_000;

/** Pełne dni do daty ISO (ujemne = już minęła). Nieparsowalna data → null. */
export function daysUntil(iso: string, nowMs: number): number | null {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return Math.ceil((ts - nowMs) / DAY_MS);
}

/** Klucz „wygasa wkrótce" gdy zostało ≤ tyle dni. */
export const KEY_EXPIRY_WARN_DAYS = 14;

export interface KeyBadgeInfo {
  variant: BadgeVariant;
  labelKey: PlKey;
  /** Dni do wygaśnięcia (tylko dla klucza aktywnego z datą; inaczej null). */
  days: number | null;
}

/**
 * Status klucza API → plakietka. Statusy z DB: active/revoked/expired
 * (packages/shared/db/repos/apiKeys.ts). Klucz active po dacie wygaśnięcia
 * (sweep TTL mógł jeszcze nie przejść) pokazujemy uczciwie jako wygasły.
 */
export function keyBadgeInfo(status: string, expiresAt: string | null, nowMs: number): KeyBadgeInfo {
  if (status === 'revoked') return { variant: 'neutral', labelKey: 'mcp.keyStatus.revoked', days: null };
  if (status === 'expired') return { variant: 'fail', labelKey: 'mcp.keyStatus.expired', days: null };
  if (status === 'active') {
    const days = expiresAt !== null ? daysUntil(expiresAt, nowMs) : null;
    if (days !== null && days <= 0) return { variant: 'fail', labelKey: 'mcp.keyStatus.expired', days };
    if (days !== null && days <= KEY_EXPIRY_WARN_DAYS) {
      return { variant: 'warn', labelKey: 'mcp.keyStatus.expiringSoon', days };
    }
    return { variant: 'ok', labelKey: 'mcp.keyStatus.active', days };
  }
  return { variant: 'neutral', labelKey: 'status.unknown', days: null };
}
