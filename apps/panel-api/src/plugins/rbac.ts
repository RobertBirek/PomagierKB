import type { FastifyInstance } from 'fastify';
import { AppError } from '@pomagierkb/shared/errors';
import type { Role } from '../types.js';

/**
 * RBAC deny-by-default z route.config:
 * - rbac: rola      → brak usera = 401 unauthorized; rola poniżej wymaganej = 403 forbidden;
 * - rbac: false LUB public: true → trasa JAWNIE publiczna (tylko /healthz,
 *   /auth/login|callback, statyki) — wymaga świadomej deklaracji;
 * - BRAK deklaracji → domyślnie rbac:'viewer' (fail-closed: zapomniana
 *   deklaracja wymaga zalogowania, nigdy nie otwiera trasy anonimowo).
 * Hierarchia: admin ⊃ operator ⊃ viewer. Żadnego trybu ALLOW_ANON.
 */

const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

/** Czysta funkcja: czy rola `actual` spełnia minimum `required`. */
export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function registerRbac(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    // Żądania bez dopasowanej trasy obsługuje notFoundHandler (404/405) —
    // globalne hooki preHandler biegną także dla niego, więc je pomijamy.
    if (req.is404) return;
    const routeConfig = req.routeOptions.config;
    if (routeConfig?.rbac === false || routeConfig?.public === true) return; // jawnie publiczna
    const required: Role = routeConfig?.rbac ?? 'viewer'; // deny-by-default
    if (req.user === null) {
      throw new AppError('unauthorized', 'Wymagane zalogowanie');
    }
    if (!roleAtLeast(req.user.role, required)) {
      throw new AppError('forbidden', `Wymagana rola: ${required}`);
    }
  });
}
