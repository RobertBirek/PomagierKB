import fastifyStatic from '@fastify/static';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** Prefiksy zarezerwowane dla API — fallback SPA ich nie przechwytuje. */
const API_PREFIXES = ['/api/', '/auth/', '/mcp/'];
const API_EXACT = new Set(['/api', '/auth', '/healthz', '/openapi.json']);

/**
 * Serwowanie frontu (WEB_DIST, domyślnie apps/panel-web/dist) z fallbackiem SPA:
 * GET nie-/api → istniejący plik albo index.html. Brak katalogu (albo brak
 * index.html) → tryb tylko-API z logiem warn (dev bez zbudowanego frontu).
 * Wołane przez server.ts PO buildApp, PRZED listen — nie wchodzi do testów API.
 */
export async function registerStatics(app: FastifyInstance): Promise<void> {
  const root = app.config.webDist;
  if (!existsSync(join(root, 'index.html'))) {
    app.log.warn({ webDist: root }, 'brak zbudowanego frontu (index.html) — serwuję tylko API');
    return;
  }

  // wildcard:false — tylko dekorator reply.sendFile; routing robimy sami niżej,
  // żeby 404/405 API (error-handler) pozostały nienaruszone.
  await app.register(fastifyStatic, { root, wildcard: false, index: false });

  app.get('/*', { config: { rbac: false, audit: false, csrf: false } }, (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    if (API_EXACT.has(path) || API_PREFIXES.some((p) => path.startsWith(p))) {
      return reply.callNotFound(); // nieznana trasa API → koperta 404/405
    }
    const rel = path.replace(/^\/+/, '');
    if (rel !== '' && !rel.includes('..')) {
      const abs = join(root, rel);
      if (existsSync(abs) && statSync(abs).isFile()) return reply.sendFile(rel);
    }
    return reply.sendFile('index.html'); // fallback SPA (routing po stronie frontu)
  });
}
