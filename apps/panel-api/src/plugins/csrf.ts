import type { FastifyInstance } from 'fastify';
import { AppError } from '@pomagierkb/shared/errors';

/**
 * CSRF wg backend-mcp §3.3 — defense-in-depth STATELESS (zero tokenów, zero
 * stanu per proces) dla tras z config.csrf === true i metod mutujących:
 * - Origin (jeśli obecny) musi być DOKŁADNIE originem config.publicUrl;
 * - Sec-Fetch-Site (jeśli obecny) ∈ {'same-origin','none'} ('none' = wpis
 *   z paska adresu / bookmarklet — nie cross-site);
 * - naruszenie → 403 csrf_rejected.
 * Wyjątki: /auth/callback jest GET (nie podlega), a trasy z config.csrf=false
 * lub bez deklaracji nie są sprawdzane (przyszłe API tokenowe deklaruje false).
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerCsrf(app: FastifyInstance): void {
  // Porównujemy origin-z-originem (URL.origin normalizuje port/wielkość liter).
  const allowedOrigin = new URL(app.config.publicUrl).origin;

  app.addHook('preHandler', async (req) => {
    if (req.is404) return; // notFoundHandler — globalne hooki biegną też dla niego
    if (req.routeOptions.config?.csrf !== true) return;
    if (!MUTATING_METHODS.has(req.method.toUpperCase())) return;

    const origin = req.headers['origin'];
    if (typeof origin === 'string' && origin !== allowedOrigin) {
      // Obejmuje też Origin: null (serializowane jako string 'null').
      throw new AppError('csrf_rejected', 'Żądanie odrzucone: nagłówek Origin spoza panelu', {
        origin,
      });
    }

    const secFetchSite = req.headers['sec-fetch-site'];
    if (
      typeof secFetchSite === 'string' &&
      secFetchSite !== 'same-origin' &&
      secFetchSite !== 'none'
    ) {
      throw new AppError(
        'csrf_rejected',
        'Żądanie odrzucone: Sec-Fetch-Site wskazuje żądanie cross-site',
        { secFetchSite },
      );
    }
  });
}
