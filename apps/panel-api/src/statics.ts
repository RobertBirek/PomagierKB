import fastifyStatic from '@fastify/static';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** Prefiksy zarezerwowane dla API — fallback SPA ich nie przechwytuje. */
const API_PREFIXES = ['/api/', '/auth/', '/mcp/'];
const API_EXACT = new Set(['/api', '/auth', '/healthz', '/openapi.json']);

/**
 * Prefiksy, pod którymi leżą WYŁĄCZNIE artefakty builda o hashowanych nazwach.
 * Nieistniejący plik pod nimi to zawsze błąd wdrożenia, nigdy trasa SPA.
 */
const BUILD_ASSET_PREFIXES = ['/assets/'];

/**
 * Czy ścieżka wygląda na plik statyczny, a nie na trasę SPA.
 *
 * Fallback zwracał `index.html` z kodem 200 dla KAŻDEJ nieznanej ścieżki — także dla
 * `/assets/index-literowka.js`. Skutek: literówka w nazwie chunku albo niekompletne
 * wdrożenie objawiały się białą stroną u użytkownika, a monitoring widział same dwusetki
 * (audyt 2026-09-06, D13-01). Przeglądarka dostawała HTML z nagłówkiem `text/html`
 * w miejscu, gdzie oczekiwała JavaScriptu — co jest też cichym błędem w konsoli, a nie
 * czytelnym 404.
 *
 * Reguła: ostatni segment ścieżki ma rozszerzenie (kropkę), albo ścieżka leży pod
 * prefiksem artefaktów builda. Trasy SPA (`/inbox`, `/kb/StagingSmoke`) rozszerzeń nie mają.
 */
export function looksLikeStaticAsset(path: string): boolean {
  if (BUILD_ASSET_PREFIXES.some((p) => path.startsWith(p))) return true;
  const last = path.split('/').pop() ?? '';
  return last.includes('.');
}

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

  // serve:false — WYŁĄCZNIE dekorator reply.sendFile, zero tras z pluginu.
  // (wildcard:false NIE wystarcza: plugin globuje katalog i tworzy trasę per plik,
  // a te trasy nie mają config.rbac → deny-by-default zwracał 401 na /assets/* — biała strona.)
  await app.register(fastifyStatic, { root, serve: false, index: false });

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
    // Nieistniejący PLIK to błąd wdrożenia — 404, żeby było go widać. Fallback SPA
    // należy się wyłącznie trasom frontu, które rozszerzeń nie mają.
    if (looksLikeStaticAsset(path)) return reply.callNotFound();
    return reply.sendFile('index.html'); // fallback SPA (routing po stronie frontu)
  });
}
