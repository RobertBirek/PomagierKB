import type { Db } from '@pomagierkb/shared/db';
import { getProfile, profileTools, resolveNamespaces, type McpProfileRow } from '@pomagierkb/shared/db';
import type { KbTool } from './tools/types.js';

/**
 * Profile MCP: cache 60 s (invalidate przez wewnętrzny endpoint) + rozstrzygnięcie
 * namespaces (namespaces_json ∩ kb_registry WHERE status='active' — repo w shared).
 */

export interface ResolvedProfile {
  profile: McpProfileRow;
  /** tools_json — whitelist narzędzi widocznych w tools/list i tools/call. */
  tools: string[];
  /** Przecięcie z aktywnymi KB — jedyny dozwolony zbiór namespaces dla narzędzi. */
  namespaces: string[];
}

const MAX_CACHED_PROFILES = 200;

export class ProfileCache {
  private readonly cache = new Map<string, { value: ResolvedProfile; expiresAt: number }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Profil enabled z rozstrzygniętymi namespaces; null = nieznany/wyłączony. */
  get(id: string): ResolvedProfile | null {
    const hit = this.cache.get(id);
    if (hit !== undefined && hit.expiresAt > this.now()) return hit.value;
    this.cache.delete(id);
    const profile = getProfile(this.db, id);
    if (profile === null || profile.enabled !== 1) return null;
    const value: ResolvedProfile = {
      profile,
      tools: profileTools(profile),
      namespaces: resolveNamespaces(this.db, profile),
    };
    if (this.cache.size >= MAX_CACHED_PROFILES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(id, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  invalidate(): void {
    this.cache.clear();
  }
}

/**
 * Deny-by-default dla zapisu: jawna deklaracja narzędzia (requiresWriteScope)
 * ma pierwszeństwo; bez niej scope 'write' wymagany dla narzędzi z destructiveHint
 * LUB bez readOnlyHint:true. Jedyny jawny wyjątek: kb_feedback (PLAN — profil
 * default 'odczyt' zawiera feedback; ocena odpowiedzi nie jest zapisem treści KB).
 */
export function toolRequiresWrite(tool: Pick<KbTool, 'annotations' | 'requiresWriteScope'>): boolean {
  if (tool.requiresWriteScope !== undefined) return tool.requiresWriteScope;
  return tool.annotations.destructiveHint === true || tool.annotations.readOnlyHint !== true;
}

export function hasWriteScope(scopes: string[]): boolean {
  return scopes.includes('write');
}
