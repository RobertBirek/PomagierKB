import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, type ErrorCode } from '@pomagierkb/shared/errors';
import { errorEnvelope } from '../lib/envelope.js';

/**
 * Centralna obsługa błędów: AppError → koperta, walidacja Fastify → validation_error
 * z details[{path,message}], 404 vs 405 (mapa tras z hooka onRoute + nagłówek Allow),
 * nieznany wyjątek → internal (bez szczegółów w odpowiedzi, pełny stack w logu).
 */

/** Mapowanie statusów błędów frameworka (np. FST_ERR_CTP_*) na kody katalogowe. */
const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'validation_error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  502: 'upstream_error',
  503: 'not_ready',
  504: 'upstream_timeout',
};

/** Wzorzec trasy find-my-way (':param', '*') → regex dopasowania konkretnego URL-a. */
function patternToRegex(pattern: string): RegExp {
  const parts = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) return '[^/]+';
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}/?$`);
}

interface RouteMethods {
  regex: RegExp;
  methods: Set<string>;
}

export function registerErrorHandler(app: FastifyInstance): void {
  // Mapa wzorzec trasy → dozwolone metody (dla rozróżnienia 404/405).
  const knownRoutes = new Map<string, RouteMethods>();

  app.addHook('onRoute', (route) => {
    // Trasy wildcard (statyki SPA) pominięte — dopasowałyby każdy URL i psuły 404.
    if (route.url.includes('*')) return;
    let entry = knownRoutes.get(route.url);
    if (!entry) {
      entry = { regex: patternToRegex(route.url), methods: new Set() };
      knownRoutes.set(route.url, entry);
    }
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) entry.methods.add(m.toUpperCase());
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(req.id);

    // 1) Błędy domenowe — kod i status z katalogu.
    if (err instanceof AppError) {
      return reply
        .status(err.statusCode)
        .send(errorEnvelope(err.code, err.message, requestId, err.details ?? undefined));
    }

    const fErr = err as {
      validation?: { instancePath?: string; message?: string }[];
      validationContext?: string;
      statusCode?: number;
      message?: string;
    };

    // 2) Błąd walidacji JSON Schema (body/query/params/headers).
    if (fErr.validation !== undefined) {
      const details = fErr.validation.map((v) => ({
        path: `${fErr.validationContext ?? 'body'}${v.instancePath ?? ''}`,
        message: v.message ?? 'nieprawidłowa wartość',
      }));
      return reply
        .status(400)
        .send(errorEnvelope('validation_error', 'Nieprawidłowe dane wejściowe', requestId, details));
    }

    // 3) Błędy frameworka ze statusem 4xx (limit body, content-type itd.).
    if (typeof fErr.statusCode === 'number' && fErr.statusCode >= 400 && fErr.statusCode < 500) {
      const code = STATUS_TO_CODE[fErr.statusCode] ?? 'validation_error';
      return reply
        .status(fErr.statusCode)
        .send(errorEnvelope(code, fErr.message ?? 'Błąd żądania', requestId));
    }

    // 4) Nieznany wyjątek: pełny błąd do logu, do klienta zero szczegółów.
    req.log.error({ err, requestId }, 'nieobsłużony wyjątek');
    return reply
      .status(500)
      .send(errorEnvelope('internal', 'Wewnętrzny błąd serwera', requestId));
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(req.id);
    const path = req.url.split('?')[0] ?? req.url;

    // Ścieżka istnieje pod inną metodą → 405 + Allow; inaczej 404.
    const allowed = new Set<string>();
    for (const entry of knownRoutes.values()) {
      if (entry.regex.test(path)) for (const m of entry.methods) allowed.add(m);
    }
    if (allowed.size > 0 && !allowed.has(req.method.toUpperCase())) {
      return reply
        .status(405)
        .header('allow', [...allowed].sort().join(', '))
        .send(
          errorEnvelope(
            'method_not_allowed',
            `Metoda ${req.method} niedozwolona dla tej ścieżki`,
            requestId,
          ),
        );
    }
    return reply.status(404).send(errorEnvelope('not_found', 'Nie znaleziono zasobu', requestId));
  });
}
