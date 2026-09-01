import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { DRAFT_LIMITS } from '@pomagierkb/shared/db';
import { AppError } from '@pomagierkb/shared/errors';
import {
  ALLOWED_EXTENSIONS,
  fileExtension,
  findIntakeByBlobPath,
  getIntake,
  getIntakeOrThrow,
  insertIntake,
  intakeToDetail,
  intakeToListItem,
  listIntakes,
  mimeForExtension,
  recallIdempotency,
  rememberIdempotency,
  saveBlob,
  type IntakeRow,
  type IntakeSourceKind,
} from '../services/intakes.js';

/**
 * Trasy /api/v1/content — Etap 1 pipeline'u (Intake, pipeline-frontend §c):
 * POST przyjmuje multipart plik (≤50 MB, whitelist rozszerzeń) LUB JSON
 * {text, title?, sourceUrl?} (sourceUrl to WYŁĄCZNIE metadana — v1 bez fetchu),
 * zapisuje blob content-addressed i wpis intakes (202 {intakeId}); przetwarza
 * asynchronicznie worker in-process (pipeline/intake-worker.ts).
 * Dedup po sha256 treści + Idempotency-Key → 200 z istniejącym id.
 * Body POST walidowane W HANDLERZE (multipart nie przechodzi przez JSON Schema).
 */

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const INTAKE_ID_PATTERN = '^intake_[0-9]{8}_[0-9a-f]{8}$';

const successRef = { $ref: 'https://pomagierkb/schemas/envelope-success.json#' } as const;
const errorRef = { $ref: 'https://pomagierkb/schemas/envelope-error.json#' } as const;

interface TextBody {
  text: string;
  title: string | null;
  sourceUrl: string | null;
}

/** Walidacja JSON body {text, title?, sourceUrl?} — ręczna (patrz komentarz modułu). */
function parseTextBody(body: unknown): TextBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError('validation_error', 'wymagany plik (multipart) albo JSON {text, title?, sourceUrl?}');
  }
  const o = body as Record<string, unknown>;
  const allowed = new Set(['text', 'title', 'sourceUrl']);
  const extra = Object.keys(o).filter((k) => !allowed.has(k));
  if (extra.length > 0) {
    throw new AppError('validation_error', `nieznane pola: ${extra.join(', ')}`);
  }
  const text = o['text'];
  if (typeof text !== 'string' || text.trim() === '') {
    throw new AppError('validation_error', 'pole text jest wymagane i nie może być puste');
  }
  if (text.length > DRAFT_LIMITS.contentMax) {
    throw new AppError('payload_too_large', `text przekracza ${DRAFT_LIMITS.contentMax} znaków`);
  }
  const title = o['title'];
  if (title !== undefined && (typeof title !== 'string' || title.length > DRAFT_LIMITS.titleMax)) {
    throw new AppError('validation_error', `title musi być tekstem ≤${DRAFT_LIMITS.titleMax} znaków`);
  }
  const sourceUrl = o['sourceUrl'];
  if (
    sourceUrl !== undefined &&
    (typeof sourceUrl !== 'string' || sourceUrl.length > 2048 || !/^https?:\/\//.test(sourceUrl))
  ) {
    throw new AppError('validation_error', 'sourceUrl musi być adresem http(s) ≤2048 znaków');
  }
  return {
    text,
    title: typeof title === 'string' && title.trim() !== '' ? title.trim() : null,
    sourceUrl: typeof sourceUrl === 'string' ? sourceUrl : null,
  };
}

/** Kształt odpowiedzi dla istniejącego intake'u (dedup/idempotency → 200). */
function existingPayload(row: IntakeRow): Record<string, unknown> {
  return {
    intakeId: row.id,
    status: row.status,
    draftId: row.draft_id,
    deduplicated: true,
  };
}

export default async function contentRoutes(app: FastifyInstance): Promise<void> {
  // Parser multipart tylko w tym scope (limit 50 MB, dokładnie 1 plik).
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  // ── POST /content — intake: plik LUB tekst; 202 {intakeId} / 200 dedup ────
  app.post(
    '/content',
    {
      config: { rbac: 'operator', audit: 'content.submit', csrf: true, rateLimitGroup: 'mutation' },
      schema: {
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 200 } },
        },
        response: { 200: successRef, 202: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req, reply) => {
      const user = req.user!;
      const idemHeader = req.headers['idempotency-key'];
      const idemKey = typeof idemHeader === 'string' && idemHeader !== '' ? idemHeader : null;

      // Idempotency-Key: powtórka tego samego żądania → istniejący intake.
      if (idemKey !== null) {
        const knownId = recallIdempotency(user.id, idemKey);
        const known = knownId !== null ? getIntake(app.db, knownId) : null;
        if (known !== null) {
          reply.auditContext = { resourceType: 'intake', resourceId: known.id, metadata: { idempotent: true } };
          return { ok: true as const, data: existingPayload(known) };
        }
      }

      let buffer: Buffer;
      let sourceKind: IntakeSourceKind;
      let originalName: string | null;
      let mime: string;
      let sourceUrl: string | null = null;

      if (req.isMultipart()) {
        const file = await req.file();
        if (file === undefined) {
          throw new AppError('validation_error', 'brak pliku w żądaniu multipart (pole file)');
        }
        const ext = fileExtension(file.filename ?? '');
        const extMime = mimeForExtension(ext);
        if (extMime === null) {
          throw new AppError(
            'validation_error',
            `nieobsługiwane rozszerzenie pliku '${ext ?? '(brak)'}'`,
            { allowedExtensions: ALLOWED_EXTENSIONS },
          );
        }
        try {
          buffer = await file.toBuffer();
        } catch (err) {
          if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
            throw new AppError('payload_too_large', 'plik przekracza limit 50 MB');
          }
          throw err;
        }
        sourceKind = 'upload';
        originalName = file.filename ?? null;
        mime = extMime;
      } else {
        const body = parseTextBody(req.body);
        buffer = Buffer.from(body.text, 'utf8');
        sourceKind = 'text';
        originalName = body.title; // titleHint dla analyze
        mime = 'text/plain';
        sourceUrl = body.sourceUrl; // tylko metadana provenance (v1 bez fetchu)
      }

      // Blob content-addressed + dedup po sha256 treści.
      const { blobPath } = saveBlob(app.config.dataDir, buffer);
      const existing = findIntakeByBlobPath(app.db, blobPath);
      if (existing !== null) {
        if (idemKey !== null) rememberIdempotency(user.id, idemKey, existing.id);
        reply.auditContext = { resourceType: 'intake', resourceId: existing.id, metadata: { deduplicated: true } };
        return { ok: true as const, data: existingPayload(existing) };
      }

      const row = insertIntake(app.db, {
        sourceKind,
        originalName,
        mime,
        sourceUrl,
        blobPath,
        createdBy: user.id,
      });
      if (idemKey !== null) rememberIdempotency(user.id, idemKey, row.id);
      reply.auditContext = {
        resourceType: 'intake',
        resourceId: row.id,
        after: { sourceKind, originalName, mime, sourceUrl },
      };
      reply.status(202);
      return { ok: true as const, data: { intakeId: row.id, status: row.status } };
    },
  );

  // ── GET /content/:intakeId — status + etapy humanized (stepper w /add) ────
  app.get<{ Params: { intakeId: string } }>(
    '/content/:intakeId',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['intakeId'],
          properties: { intakeId: { type: 'string', pattern: INTAKE_ID_PATTERN } },
        },
        response: { 200: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req) => ({
      ok: true as const,
      data: { intake: intakeToDetail(getIntakeOrThrow(app.db, req.params.intakeId)) },
    }),
  );

  // ── GET /content?limit — ostatnie intake'y ────────────────────────────────
  app.get<{ Querystring: { limit: number } }>(
    '/content',
    {
      config: { rbac: 'viewer', audit: false, csrf: false },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        },
        response: { 200: successRef, '4xx': errorRef, '5xx': errorRef },
      },
    },
    async (req) => ({
      ok: true as const,
      data: { items: listIntakes(app.db, req.query.limit).map(intakeToListItem) },
      meta: { limit: req.query.limit },
    }),
  );
}
