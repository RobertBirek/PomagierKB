import type { FastifyInstance } from 'fastify';
import { putSetting } from '../services/settings.js';
import { coerceBackupConfig, readBackupState, requestBackupRun, type BackupRunKind } from '../services/backup.js';

/**
 * Trasy strony /backup (wszystkie admin):
 * - GET  /backup/state   — stan raportowany przez hosta + werdykty + konfiguracja;
 * - PUT  /backup/config  — parametry NIESEKRETNE (retencja, off-site on/off, cold Neo4j);
 * - POST /backup/run     — żądanie biegu backupu albo weryfikacji (plik-znacznik).
 *
 * Czego tu NIE MA i nie będzie: odtwarzania. Restore nadpisuje wszystkie magazyny naraz
 * i musi być wykonywany świadomie na hoście — strona pokazuje komendy, człowiek je
 * uruchamia. Sekrety (poświadczenia rclone, klucz age, URL-e push-monitorów) też nie
 * przechodzą przez te trasy: mieszkają w /etc/kag/alerts.env i tylko tam.
 * Logika w services/backup.ts.
 */
export default async function backupRoutes(app: FastifyInstance): Promise<void> {
  const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' };

  app.get(
    '/backup/state',
    {
      config: { rbac: 'admin', audit: false, csrf: false },
      schema: { response: { 200: successRef } },
    },
    async () => ({ ok: true as const, data: readBackupState(app.db, app.config) }),
  );

  app.put<{ Body: Record<string, unknown> }>(
    '/backup/config',
    {
      config: { rbac: 'admin', audit: 'backup.config.update', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            retentionDays: { type: 'integer', minimum: 2, maximum: 365 },
            monthlyRetentionMonths: { type: 'integer', minimum: 0, maximum: 120 },
            offsiteEnabled: { type: 'boolean' },
            coldNeo4jEnabled: { type: 'boolean' },
          },
        },
        response: { 200: successRef },
      },
    },
    async (req, reply) => {
      // Walidacja idzie DWA razy: JSON Schema odrzuca kształt, coerce* pilnuje zakresów
      // i uzupełnia domyślne. Zapis przez putSetting, bo to on eksportuje konfigurację
      // do pliku czytanego przez skrypty hosta — ominięcie go dałoby panel i hosta
      // rozjechane o jedną zmianę.
      const value = coerceBackupConfig(req.body);
      putSetting(app.db, app.config, 'backup', value, req.user?.id ?? null);
      reply.auditContext = { resourceType: 'setting', resourceId: 'backup', after: value };
      return { ok: true as const, data: value };
    },
  );

  app.post<{ Body: { kind: BackupRunKind } }>(
    '/backup/run',
    {
      config: { rbac: 'admin', audit: 'backup.run.request', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: { type: 'string', enum: ['backup', 'verify'] } },
        },
        response: { 200: successRef },
      },
    },
    async (req, reply) => {
      const request = requestBackupRun(app.config, req.body.kind);
      reply.auditContext = {
        resourceType: 'backup',
        resourceId: request.requestId,
        after: { kind: request.kind, requestedAt: request.requestedAt },
      };
      return { ok: true as const, data: request };
    },
  );
}
