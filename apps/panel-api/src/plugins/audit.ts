import type { FastifyInstance } from 'fastify';
import { appendAudit } from '@pomagierkb/shared/audit';

/**
 * Hook audytu: onResponse dla tras z config.audit (nazwa akcji, np. 'draft.promote').
 * Serwis może wzbogacić wpis przez reply.auditContext = {resourceType,resourceId,
 * before,after,metadata} — bez tego resourceId zgadywane z params (:id | :namespace).
 * Zapis przez appendAudit z shared (hash-chain, BEGIN IMMEDIATE, redakcja sekretów).
 * Błąd zapisu audytu NIE psuje odpowiedzi (ta już wyszła) — tylko log error.
 */
export function registerAudit(app: FastifyInstance): void {
  app.decorateReply('auditContext', null);

  app.addHook('onResponse', async (req, reply) => {
    const action = req.routeOptions.config?.audit;
    if (action === undefined || action === false) return;

    const ctx = reply.auditContext;
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
