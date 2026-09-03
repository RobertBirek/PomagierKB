/**
 * Role przez PERSONY (docs/design/ulepszenia-panel-4-soczewek.txt, soczewka product):
 * - viewer  = każdy pracownik: pyta bazę, daje feedback, PROPONUJE treść (draft do inboxu);
 * - operator = kurator wiedzy: + recenzja inboxu, ingest treści, build KB, luki wiedzy;
 * - admin   = IT: + tworzenie KB, klucze MCP, ustawienia/audyt.
 * Gating w UI to tylko UX — egzekwuje backend (RBAC per trasa).
 * Czysta funkcja — testy w test/permissions.test.ts.
 */

export type Role = 'viewer' | 'operator' | 'admin';

export type Permission =
  | 'ask' // strona Zapytaj (czat z bazą)
  | 'feedback' // 👍/👎 pod odpowiedziami
  | 'propose' // formularz Dodaj treść (wynik = draft w inboxie)
  | 'inbox' // recenzja draftów (promote/reject/withdraw)
  | 'content' // pełny ingest treści (nadzór intake'ów)
  | 'kb-build' // build/preflight/quality gate istniejących KB
  | 'gaps' // zarządzanie lukami wiedzy
  | 'kb-create' // tworzenie/provisioning nowych KB
  | 'mcp' // klucze API i profile MCP
  | 'settings'; // ustawienia (LLM, progi, audyt, system)

const VIEWER_PERMS: readonly Permission[] = ['ask', 'feedback', 'propose'];
const OPERATOR_PERMS: readonly Permission[] = [...VIEWER_PERMS, 'inbox', 'content', 'kb-build', 'gaps'];
const ADMIN_PERMS: readonly Permission[] = [...OPERATOR_PERMS, 'kb-create', 'mcp', 'settings'];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER_PERMS),
  operator: new Set(OPERATOR_PERMS),
  admin: new Set(ADMIN_PERMS),
};

/** Czy rola ma uprawnienie. Nieznana rola (defensywnie) → false (fail-closed). */
export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (role === null || role === undefined) return false;
  const perms = ROLE_PERMISSIONS[role] as ReadonlySet<Permission> | undefined;
  return perms !== undefined && perms.has(permission);
}

/** Uprawnienie wymagane do zobaczenia strony w nawigacji. */
export const PAGE_PERMISSION: Record<string, Permission> = {
  '/overview': 'ask',
  '/ask': 'ask',
  '/add': 'propose',
  '/inbox': 'inbox',
  '/kb': 'kb-build',
  '/mcp': 'mcp',
  '/settings': 'settings',
};
