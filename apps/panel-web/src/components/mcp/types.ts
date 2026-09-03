/**
 * Kształty odpowiedzi API strony /mcp — lustro apps/panel-api/src/services/
 * mcp-admin.ts + routes/{mcp-admin,users}.ts. Wspólne dla McpPage i components/mcp/*.
 */

export interface ApiKeyView {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  scopes: string[];
  profileId: string;
  status: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  lastUsedAt: string | null;
  requestsCount: number;
  revokedAt: string | null;
}

export interface McpProfileView {
  id: string;
  name: string;
  description: string | null;
  namespaces: string[] | null;
  tools: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpSnippetsView {
  profileId: string;
  url: string;
  snippets: { claudeCode: string; cursor: string; generic: string };
}

export interface McpHealthView {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  detail: string;
}

export interface UserView {
  id: string;
  sub: string | null;
  email: string | null;
  displayName: string;
  kind: 'oidc' | 'service';
  role: 'viewer' | 'operator' | 'admin';
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface KbListView {
  items: { namespace: string; name: string; status: string }[];
}
