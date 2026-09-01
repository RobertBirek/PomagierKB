import { createReadStream, existsSync, openSync, closeSync, fstatSync, readSync, watch, type FSWatcher } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  getAction,
  getActionOrThrow,
  listActions,
  type ActionRow,
  type ActionStatus,
} from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import { cancelRunningAction, logTailLines } from '../services/actions-runner.js';
import { ACTION_STATUSES, humanize } from '../services/messages.js';

/**
 * Trasy /api/v1/actions — monitoring i sterowanie długobieżnymi akcjami:
 * - GET  /actions                 (viewer)   lista z filtrami status/type + paginacja;
 * - GET  /actions/:id             (viewer)   szczegóły + logTail (ostatnie 200 linii);
 * - GET  /actions/:id/log         (viewer)   pełny log text/plain (stream z dysku);
 * - GET  /actions/:id/events      (viewer)   SSE: progress (poll wiersza), log
 *                                            (fs.watch + odczyt przyrostowy), status
 *                                            terminalny → koniec strumienia;
 * - POST /actions/:id/cancel      (operator) 202; 409 gdy akcja nie jest running.
 * Startowanie akcji robią trasy domenowe (kbs/drafts) przez services/actions-runner.
 */

const ID_PATTERN = '^act_[0-9]{8}_[0-9a-f]{8}$';

const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: ID_PATTERN } },
} as const;

const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' } as const;
const errorRef = { $ref: 'https://pomagierkb/schemas/envelope-error.json#' } as const;

/** JSON.parse z fallbackiem — kolumny *_json nie mogą wywrócić odpowiedzi. */
function safeParse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** DTO akcji dla API (camelCase; pid zostaje wewnętrzny; label ze słownika PL). */
function toActionDto(row: ActionRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    resource: row.resource,
    status: row.status,
    statusLabel: humanize(row.status).label,
    params: safeParse<Record<string, unknown>>(row.params_json, {}),
    progress: safeParse<Record<string, unknown> | null>(row.progress_json, null),
    startedBy: row.started_by,
    exitCode: row.exit_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export default async function actionsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /actions — lista z filtrami ───────────────────────────────────────
  app.get<{ Querystring: { status?: ActionStatus; type?: string; page: number; limit: number } }>(
    '/actions',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: [...ACTION_STATUSES] },
            type: { type: 'string', minLength: 1, maxLength: 64 },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
        response: { 200: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req) => {
      const { status, type, page, limit } = req.query;
      const { items, total } = listActions(app.db, {
        ...(status !== undefined && { status }),
        ...(type !== undefined && { type }),
        limit,
        offset: (page - 1) * limit,
      });
      return { ok: true, data: { items: items.map(toActionDto) }, meta: { page, limit, total } };
    },
  );

  // ── GET /actions/:id — szczegóły + logTail ────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/actions/:id',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { params: paramsSchema, response: { 200: successRef, '4xx': errorRef, '5xx': errorRef } },
    },
    async (req) => {
      const row = getActionOrThrow(app.db, req.params.id);
      return { ok: true, data: { ...toActionDto(row), logTail: logTailLines(row.log_path, 200) } };
    },
  );

  // ── GET /actions/:id/log — pełny log jako text/plain (stream) ─────────────
  app.get<{ Params: { id: string } }>(
    '/actions/:id/log',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { params: paramsSchema },
    },
    async (req, reply) => {
      const row = getActionOrThrow(app.db, req.params.id);
      if (!existsSync(row.log_path)) {
        throw new AppError('not_found', `log akcji ${row.id} nie istnieje na dysku`);
      }
      reply.header('content-type', 'text/plain; charset=utf-8');
      return reply.send(createReadStream(row.log_path));
    },
  );

  // ── GET /actions/:id/events — SSE (progress/log/status) ───────────────────
  // audit:false (hijack pomija onResponse). Log jest odtwarzany od początku
  // pliku i dosyłany przyrostowo (fs.watch + odczyt od offsetu); wiersz akcji
  // odpytywany co 2 s (event progress przy zmianie); status terminalny kończy
  // strumień. Heartbeat co 15 s zapewnia plugin sse.
  app.get<{ Params: { id: string } }>(
    '/actions/:id/events',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { params: paramsSchema },
    },
    async (req, reply) => {
      const actionId = req.params.id;
      // 404 PRZED hijackiem — koperta błędu musi wyjść normalną ścieżką.
      const initial = getAction(app.db, actionId);
      if (initial === null) throw new AppError('not_found', `akcja nie istnieje: ${actionId}`);

      const sink = reply.sse();
      const pollMs = app.config.nodeEnv === 'test' ? 100 : 2_000;
      const logPath = initial.log_path;

      // Odczyt przyrostowy logu od offsetu; niedokończona linia czeka w buforze.
      let offset = 0;
      let pendingChunk = '';
      const sendNewLogLines = (): void => {
        let fd: number;
        try {
          fd = openSync(logPath, 'r');
        } catch {
          return; // plik logu mógł jeszcze nie powstać
        }
        try {
          const size = fstatSync(fd).size;
          if (size < offset) offset = 0; // log podmieniony/obcięty — czytamy od nowa
          if (size === offset) return;
          const buf = Buffer.alloc(size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          pendingChunk += buf.toString('utf8');
          const parts = pendingChunk.split('\n');
          pendingChunk = parts.pop() ?? '';
          const lines = parts.filter((l) => l !== '');
          if (lines.length > 0) sink.send('log', { lines });
        } catch (err) {
          req.log.warn({ err }, 'odczyt przyrostowy logu SSE nie powiódł się');
        } finally {
          closeSync(fd);
        }
      };

      // fs.watch dosyła linie natychmiast; poll co 2 s to siatka bezpieczeństwa.
      let watcher: FSWatcher | null = null;
      try {
        watcher = watch(logPath, () => sendNewLogLines());
      } catch {
        req.log.warn({ logPath }, 'fs.watch niedostępny — log tylko przez polling');
      }

      let lastProgressJson: string | null = null;
      let done = false;
      const tick = (): void => {
        if (done) return;
        let row: ActionRow | null = null;
        try {
          row = getAction(app.db, actionId);
        } catch (err) {
          req.log.warn({ err }, 'odczyt akcji dla SSE nie powiódł się');
          return;
        }
        if (row === null) {
          done = true;
          sink.send('status', { status: 'error', label: humanize('error').label });
          sink.close();
          return;
        }
        if (row.progress_json !== null && row.progress_json !== lastProgressJson) {
          lastProgressJson = row.progress_json;
          sink.send('progress', safeParse<Record<string, unknown>>(row.progress_json, {}));
        }
        sendNewLogLines();
        if (row.status !== 'running') {
          done = true;
          sendNewLogLines(); // domknięcie: resztki logu przed statusem
          sink.send('status', {
            status: row.status,
            exitCode: row.exit_code,
            label: humanize(row.status).label,
          });
          sink.close();
        }
      };

      const timer = setInterval(tick, pollMs);
      sink.onClose(() => {
        done = true;
        clearInterval(timer);
        watcher?.close();
      });
      tick(); // pierwszy strzał od razu (log od początku + bieżący progress/status)
    },
  );

  // ── POST /actions/:id/cancel — anulowanie akcji running ───────────────────
  app.post<{ Params: { id: string } }>(
    '/actions/:id/cancel',
    {
      config: { rbac: 'operator', audit: 'action.cancel', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        params: paramsSchema,
        response: { 202: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req, reply) => {
      const row = cancelRunningAction(
        { db: app.db, warn: (msg) => req.log.warn(msg) },
        req.params.id,
      );
      reply.auditContext = {
        resourceType: 'action',
        resourceId: row.id,
        metadata: { type: row.type, resource: row.resource, status: row.status },
      };
      reply.code(202);
      return { ok: true, data: toActionDto(row) };
    },
  );
}
