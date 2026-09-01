import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import type { Role } from '../lib/permissions';

/** Kształt GET /api/v1/me (apps/panel-api/src/routes/me.ts). */
export interface Me {
  user: {
    id: string;
    email: string | null;
    displayName: string;
    role: Role;
  };
  session: { expiresAt: string };
}

/**
 * Tożsamość zalogowanego użytkownika. Brak sesji (401) → apiFetch robi twardy
 * redirect na /auth/login?returnTo=..., więc strony mogą zakładać, że me istnieje.
 */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<Me>('/api/v1/me'),
    staleTime: 60_000,
  });
}
