import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '@pomagierkb/shared/errors';

/**
 * Rate limiting (@fastify/rate-limit, store w pamięci — jeden proces):
 * - globalnie config.rateLimits.global req/min/IP (trustProxy:1 ustawione w buildApp
 *   — jedynym hopem jest Caddy, więc req.ip to realny adres klienta);
 * - grupy per trasa przez route.config.rateLimitGroup:
 *   'auth'     → rateLimits.auth req/min/IP (trasy /auth/*),
 *   'mutation' → rateLimits.mutation req/min per sesja (keyGenerator:
 *                req.user?.sessionHash || req.ip).
 * Hook onRoute tłumaczy grupę na natywny config.rateLimit pluginu — musi być
 * dodany PRZED rejestracją pluginu (kolejność hooków onRoute).
 * 429 → koperta rate_limited + nagłówek Retry-After.
 */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  const limits = app.config.rateLimits;
  const minute = 60_000;

  app.addHook('onRoute', (route) => {
    const group = route.config?.rateLimitGroup;
    if (group === undefined) return;
    const config = (route.config ??= {});
    if (group === 'auth') {
      config.rateLimit = { max: limits.auth, timeWindow: minute };
    } else if (group === 'mutation') {
      config.rateLimit = {
        max: limits.mutation,
        timeWindow: minute,
        keyGenerator: (req: FastifyRequest) => req.user?.sessionHash ?? req.ip,
      };
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: limits.global,
    timeWindow: minute,
    keyGenerator: (req) => req.ip,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    // Plugin RZUCA wynik buildera — zwracamy AppError, więc kopertę (z requestId)
    // formatuje centralny error-handler; nagłówek Retry-After plugin ustawia wcześniej.
    errorResponseBuilder: (_req, context) =>
      new AppError(
        'rate_limited',
        `Przekroczono limit ${context.max} żądań na minutę — spróbuj ponownie za ${context.after}`,
        { max: context.max, retryAfterMs: context.ttl },
      ),
  });
}
