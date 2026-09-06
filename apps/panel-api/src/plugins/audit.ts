import type { FastifyInstance } from 'fastify';
import { appendAudit } from '@pomagierkb/shared/audit';

/**
 * Hook audytu: onResponse dla tras z config.audit (nazwa akcji, np. 'draft.promote').
 * Serwis może wzbogacić wpis przez reply.auditContext = {resourceType,resourceId,
 * before,after,metadata} — bez tego resourceId zgadywane z params (:id | :namespace).
 * Zapis przez appendAudit z shared (hash-chain, BEGIN IMMEDIATE, redakcja sekretów).
 * Błąd zapisu audytu NIE psuje odpowiedzi (ta już wyszła) — tylko log error.
 */

export interface AuditDecision {
  /** Kod odpowiedzi, która już poszła do klienta. */
  statusCode: number;
  /** Czy żądanie miało zalogowanego użytkownika (req.user !== null). */
  authenticated: boolean;
  /** Czy handler świadomie opisał zdarzenie (reply.auditContext !== null). */
  hasContext: boolean;
}

/**
 * Czy zdarzenie trafia do append-only łańcucha audytu (czysta logika, testowana).
 *
 * Powód (audyt D3-02): KAŻDE anonimowe żądanie do /auth/callback — także odrzucone
 * limitem (429) i 400 „brak transakcji logowania" — dopisywało wiersz auth.login.
 * Tabela audit jest append-only i bez retencji, więc nieuwierzytelniony skaner mógł
 * ją zapychać (kontencja WAL na bazie współdzielonej z mcp-serverem, prawdziwe
 * zdarzenia auth tonące w szumie).
 *
 * Zasada „każda mutacja audytowana" zostaje nienaruszona: nieudana próba BEZ
 * transakcji nie jest mutacją. Audytujemy zatem:
 * - każdą odpowiedź < 400 (mutacja się dokonała),
 * - każdą próbę uwierzytelnionego aktora (rozliczalność — kto co próbował),
 * - każde zdarzenie, które handler jawnie opisał (auditContext), np. logowanie
 *   odrzucone przez IdP albo z braku grupy kag-*.
 * Pomijamy 429 (żądanie w ogóle nie dotarło do handlera) oraz anonimowe błędy
 * bez kontekstu — te idą wyłącznie do logu pino (z IP) jako metryka.
 */
export function shouldAudit({ statusCode, authenticated, hasContext }: AuditDecision): boolean {
  if (statusCode === 429) return false;
  if (statusCode < 400) return true;
  if (hasContext) return true;
  return authenticated;
}

export function registerAudit(app: FastifyInstance): void {
  app.decorateReply('auditContext', null);

  app.addHook('onResponse', async (req, reply) => {
    const action = req.routeOptions.config?.audit;
    if (action === undefined || action === false) return;

    const ctx = reply.auditContext;
    if (
      !shouldAudit({
        statusCode: reply.statusCode,
        authenticated: req.user !== null,
        hasContext: ctx !== null && ctx !== undefined,
      })
    ) {
      // Licznik/metryka zamiast wiersza w łańcuchu — IP jest realne po naprawie D2-01.
      req.log.warn(
        { action, statusCode: reply.statusCode, ip: req.ip },
        'nieuwierzytelniona próba odrzucona przed mutacją — bez wpisu w audycie',
      );
      return;
    }

    const params = (req.params ?? {}) as Record<string, unknown>;
    const fallbackId =
      typeof params['id'] === 'string'
        ? params['id']
        : typeof params['namespace'] === 'string'
          ? params['namespace']
          : null;

    try {
      appendAudit(app.db, {
        actor: req.user?.id ?? 'anonymous',
        actorType: req.user !== null ? 'user' : 'system',
        role: req.user?.role ?? null,
        action,
        resourceType: ctx?.resourceType ?? null,
        resourceId: ctx?.resourceId ?? fallbackId,
        outcome: reply.statusCode < 400 ? 'success' : 'error',
        before: ctx?.before,
        after: ctx?.after,
        metadata: {
          ...ctx?.metadata,
          requestId: String(req.id),
          method: req.method,
          url: req.routeOptions.url ?? req.url,
          statusCode: reply.statusCode,
        },
      });
    } catch (err) {
      req.log.error({ err, action }, 'zapis audytu nie powiódł się');
    }
  });
}
