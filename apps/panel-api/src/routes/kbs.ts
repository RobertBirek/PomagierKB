import type { FastifyInstance } from 'fastify';
import type { KbStatus } from '@pomagierkb/shared/db';
import { getKbOrThrow } from '@pomagierkb/shared/db';
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

  // ── POST /kbs/:namespace/build — kontrakt gotowy, job build-kb w Fazie 4 ──
  app.post<{ Params: NamespaceParams }>(
    '/kbs/:namespace/build',
    {
      config: { rbac: 'operator', audit: false, csrf: true, rateLimitGroup: 'mutation' },
      schema: { params: namespaceParamsSchema },
    },
    async (req, reply) => {
      getKbOrThrow(req.server.db, req.params.namespace); // 404 dla nieistniejącej bazy
      // TODO(Faza 4): preflightBuild → 422 przy fail, akcja build_kb (spawn detached,
      // eksport CSV → upload → builder job → quality gate). Kod 'not_implemented'
      // spoza katalogu shared/errors — koperta budowana ręcznie do czasu Fazy 4.
      return reply.status(501).send({
        ok: false,
        error: {
          code: 'not_implemented',
          message: 'Build bazy wiedzy powstanie w Fazie 4 — kontrakt trasy i preflight są już gotowe.',
          requestId: String(req.id),
        },
      });
    },
  );
}
