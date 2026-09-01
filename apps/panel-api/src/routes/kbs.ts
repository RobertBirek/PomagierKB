import type { FastifyInstance } from 'fastify';
import type { KbStatus } from '@pomagierkb/shared/db';
import { getKbOrThrow, latestQualityReport } from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import { listJobs } from '@pomagierkb/shared/openspg';
import {
  createKbEntry,
  getKbEntry,
  kbToApi,
  listKbEntries,
  makeOpenSpgClient,
  patchKbEntry,
  preflightBuild,
} from '../services/kb.js';
import { humanize } from '../services/messages.js';
import { assertPreflight } from '../services/preflight.js';
import { startAction } from '../services/actions-runner.js';
import { launchKbAction } from '../jobs/kb-runner.js';
import { runCreateKbJob } from '../jobs/create-kb.js';
import { assertSchemaSyncSafe, planSchemaSync, runSchemaSyncJob } from '../jobs/schema-sync.js';

/**
 * Trasy /api/v1/kbs — rejestr baz wiedzy + provisioning + schemat.
 * Tylko deklaracje (schema + config {rbac,audit,csrf}) — logika w services/kb.ts
 * i jobs/{create-kb,schema-sync}.ts. Ścieżki BEZ prefiksu /api/v1 (dodaje go
 * rejestracja w routes/index.ts).
 */

const NAMESPACE_PATTERN = '^[A-Z][A-Za-z0-9]{2,29}$';

const namespaceParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['namespace'],
  properties: {
    namespace: { type: 'string', pattern: NAMESPACE_PATTERN },
  },
} as const;

const successResponse = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' } as const;

const createKbBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['namespace', 'name'],
  properties: {
    namespace: { type: 'string', pattern: NAMESPACE_PATTERN },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000, default: '' },
    documentTypes: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          description: { type: 'string', maxLength: 500, default: '' },
        },
      },
    },
    createProject: { type: 'boolean', default: false },
  },
} as const;

const patchKbBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    // Legalność przejść pilnuje transitionKb (409 przy nielegalnym) — enum tylko
    // odcina literówki. Archiwizacja = PATCH {status:'archived'} (soft delete).
    status: { type: 'string', enum: ['draft', 'provisioning', 'active', 'error', 'archived'] },
    config: { type: 'object' },
  },
} as const;

interface NamespaceParams {
  namespace: string;
}

export default async function kbsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /kbs — rejestr z totalsami (documents/chunks/pendingDrafts, cache 10 s) ──
  app.get(
    '/kbs',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { response: { 200: successResponse } },
    },
    async (req) => ({ ok: true as const, data: { items: listKbEntries(req.server.db) } }),
  );

  // ── POST /kbs — nowy wpis rejestru; createProject:true → 202 akcja create_kb ──
  app.post<{ Body: {
    namespace: string;
    name: string;
    description: string;
    documentTypes?: { name: string; description: string }[];
    createProject: boolean;
  } }>(
    '/kbs',
    {
      config: { rbac: 'admin', audit: 'kb.create', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        body: createKbBodySchema,
        response: { 201: successResponse, 202: successResponse },
      },
    },
    async (req, reply) => {
      const db = req.server.db;
      const row = createKbEntry(db, {
        namespace: req.body.namespace,
        name: req.body.name,
        description: req.body.description,
        documentTypes: req.body.documentTypes,
      });
      reply.auditContext = {
        resourceType: 'kb',
        resourceId: row.namespace,
        after: { namespace: row.namespace, name: row.name, status: row.status },
        metadata: { createProject: req.body.createProject },
      };

      if (!req.body.createProject) {
        return reply.status(201).send({ ok: true as const, data: { kb: kbToApi(db, row) } });
      }

      const launched = launchKbAction(
        {
          db,
          config: req.server.config,
          client: makeOpenSpgClient(req.server.config),
          startedBy: req.user?.id ?? null,
        },
        {
          type: 'create_kb',
          namespace: row.namespace,
          params: { namespace: row.namespace },
          run: runCreateKbJob,
        },
      );
      return reply.status(202).send({
        ok: true as const,
        data: {
          kb: kbToApi(db, getKbOrThrow(db, row.namespace)),
          actionId: launched.actionId,
          type: launched.type,
          resource: launched.resource,
          logPath: launched.logPath,
        },
      });
    },
  );

  // ── GET /kbs/:namespace — detal z totalsami; 404 gdy brak ──
  app.get<{ Params: NamespaceParams }>(
    '/kbs/:namespace',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { params: namespaceParamsSchema, response: { 200: successResponse } },
    },
    async (req) => ({ ok: true as const, data: { kb: getKbEntry(req.server.db, req.params.namespace) } }),
  );

  // ── PATCH /kbs/:namespace — tylko name/description/status/config ──
  app.patch<{ Params: NamespaceParams; Body: {
    name?: string;
    description?: string;
    status?: KbStatus;
    config?: Record<string, unknown>;
  } }>(
    '/kbs/:namespace',
    {
      config: { rbac: 'admin', audit: 'kb.update', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        params: namespaceParamsSchema,
        body: patchKbBodySchema,
        response: { 200: successResponse },
      },
    },
    async (req, reply) => {
      const db = req.server.db;
      const { before, after } = patchKbEntry(db, req.params.namespace, req.body);
      reply.auditContext = {
        resourceType: 'kb',
        resourceId: req.params.namespace,
        before: { name: before.name, description: before.description, status: before.status, config: before.config_json },
        after: { name: after.name, description: after.description, status: after.status, config: after.config_json },
      };
      return { ok: true as const, data: { kb: kbToApi(db, after) } };
    },
  );

  // ── POST /kbs/:namespace/preflight — dry-run checków buildu (bez mutacji) ──
  app.post<{ Params: NamespaceParams }>(
    '/kbs/:namespace/preflight',
    {
      config: { rbac: 'operator', audit: false, csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: namespaceParamsSchema, response: { 200: successResponse } },
    },
    async (req) => {
      const result = await preflightBuild(
        { db: req.server.db, config: req.server.config, client: makeOpenSpgClient(req.server.config) },
        req.params.namespace,
      );
      return { ok: true as const, data: result };
    },
  );

  // ── POST /kbs/:namespace/schema-sync — addytywna aktualizacja schematu (202) ──
  app.post<{ Params: NamespaceParams }>(
    '/kbs/:namespace/schema-sync',
    {
      config: { rbac: 'admin', audit: 'kb.schema_sync', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: namespaceParamsSchema, response: { 202: successResponse } },
    },
    async (req, reply) => {
      const db = req.server.db;
      // Preflight w trasie: destrukcyjny diff → 422 preflight_failed z listą naruszeń.
      const plan = planSchemaSync(db, req.params.namespace);
      assertSchemaSyncSafe(plan);

      const launched = launchKbAction(
        {
          db,
          config: req.server.config,
          client: makeOpenSpgClient(req.server.config),
          startedBy: req.user?.id ?? null,
        },
        {
          type: 'schema_sync',
          namespace: req.params.namespace,
          params: { namespace: req.params.namespace, nextVersion: plan.nextVersion, unchanged: plan.unchanged },
          run: runSchemaSyncJob,
        },
      );
      reply.auditContext = {
        resourceType: 'kb',
        resourceId: req.params.namespace,
        metadata: { actionId: launched.actionId, nextVersion: plan.nextVersion, unchanged: plan.unchanged },
      };
      return reply.status(202).send({
        ok: true as const,
        data: {
          actionId: launched.actionId,
          type: launched.type,
          resource: launched.resource,
          logPath: launched.logPath,
        },
      });
    },
  );

  // ── GET /kbs/:namespace/jobs — proxy builder/job/list (start=1!) ──
  app.get<{ Params: NamespaceParams; Querystring: { limit: number } }>(
    '/kbs/:namespace/jobs',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: {
        params: namespaceParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        },
        response: { 200: successResponse },
      },
    },
    async (req) => {
      const kb = getKbOrThrow(req.server.db, req.params.namespace);
      if (kb.project_id === null) {
        throw new AppError('conflict', `baza ${kb.namespace} nie ma jeszcze projektu OpenSPG — najpierw provisioning`);
      }
      const client = makeOpenSpgClient(req.server.config);
      const jobs = await listJobs(client, kb.project_id, { start: 1, limit: req.query.limit });
      const items = jobs.map((j) => {
        const status = typeof j.status === 'string' ? j.status : 'UNKNOWN';
        return {
          id: typeof j.id === 'number' ? j.id : null,
          name: typeof j.jobName === 'string' ? j.jobName : '',
          status,
          // Normalizacja przez wspólny słownik komunikatów PL (services/messages.ts).
          statusLabel: humanize(status).label,
          fileUrl: typeof j.fileUrl === 'string' ? j.fileUrl : null,
          createdAt: typeof j.gmtCreate === 'string' ? j.gmtCreate : null,
          modifiedAt: typeof j['gmtModified'] === 'string' ? (j['gmtModified'] as string) : null,
        };
      });
      return { ok: true as const, data: { items } };
    },
  );

  // ── POST /kbs/:namespace/build — 202: akcja build_kb (spawn detached przez
  //    services/actions-runner; preflight w trasie → 422 preflight_failed) ──
  app.post<{ Params: NamespaceParams; Body: { force?: boolean } | null }>(
    '/kbs/:namespace/build',
    {
      config: { rbac: 'operator', audit: 'kb.build', csrf: true, rateLimitGroup: 'mutation' },
      // Body celowo BEZ schematu: POST bez treści jest legalny (schemat JSON
      // odrzuciłby brak body jako 400) — jedyny parametr {force} czytamy defensywnie.
      schema: { params: namespaceParamsSchema, response: { 202: successResponse } },
    },
    async (req, reply) => {
      const db = req.server.db;
      const namespace = req.params.namespace;
      getKbOrThrow(db, namespace); // 404 dla nieistniejącej bazy

      const preflight = await preflightBuild(
        { db, config: req.server.config, client: makeOpenSpgClient(req.server.config) },
        namespace,
      );
      assertPreflight(preflight); // 422 preflight_failed z details.checks

      const force =
        typeof req.body === 'object' && req.body !== null && (req.body as Record<string, unknown>)['force'] === true;
      // Guard idempotencji repo actions (ux_actions_running) → 409 action_already_running.
      const action = startAction(
        { db, dataDir: req.server.config.dataDir, warn: (msg) => req.log.warn(msg) },
        {
          type: 'build_kb',
          resource: `kb:${namespace}`,
          params: { namespace, force },
          startedBy: req.user?.id ?? null,
        },
      );
      reply.auditContext = {
        resourceType: 'kb',
        resourceId: namespace,
        metadata: { actionId: action.id, force },
      };
      return reply.status(202).send({
        ok: true as const,
        data: { actionId: action.id, type: action.type, resource: action.resource, logPath: action.log_path },
      });
    },
  );

  // ── POST /kbs/:namespace/quality — 202: akcja quality_gate na żądanie ──
  app.post<{ Params: NamespaceParams }>(
    '/kbs/:namespace/quality',
    {
      config: { rbac: 'operator', audit: 'kb.quality_gate', csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: namespaceParamsSchema, response: { 202: successResponse } },
    },
    async (req, reply) => {
      const db = req.server.db;
      const namespace = req.params.namespace;
      getKbOrThrow(db, namespace);
      const action = startAction(
        { db, dataDir: req.server.config.dataDir, warn: (msg) => req.log.warn(msg) },
        {
          type: 'quality_gate',
          resource: `kb:${namespace}`,
          params: { namespace },
          startedBy: req.user?.id ?? null,
        },
      );
      reply.auditContext = {
        resourceType: 'kb',
        resourceId: namespace,
        metadata: { actionId: action.id },
      };
      return reply.status(202).send({
        ok: true as const,
        data: { actionId: action.id, type: action.type, resource: action.resource, logPath: action.log_path },
      });
    },
  );

  // ── GET /kbs/:namespace/quality — ostatni raport jakości (null gdy brak) ──
  app.get<{ Params: NamespaceParams }>(
    '/kbs/:namespace/quality',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: { params: namespaceParamsSchema, response: { 200: successResponse } },
    },
    async (req) => {
      const db = req.server.db;
      getKbOrThrow(db, req.params.namespace);
      const row = latestQualityReport(db, req.params.namespace);
      let checks: unknown[] = [];
      if (row !== null) {
        try {
          const parsed = JSON.parse(row.checks_json) as unknown;
          if (Array.isArray(parsed)) checks = parsed;
        } catch {
          /* uszkodzony JSON nie może wywrócić odczytu raportu */
        }
      }
      return {
        ok: true as const,
        data: {
          report:
            row === null
              ? null
              : {
                  id: row.id,
                  runId: row.run_id,
                  verdict: row.verdict,
                  verdictLabel: humanize(row.verdict).label,
                  checks,
                  createdAt: row.created_at,
                },
        },
      };
    },
  );
}
