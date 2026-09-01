import { ERROR_CODES } from '../errors.js';

/**
 * Koperta odpowiedzi /api/v1 (kontrakt z docs/design/backend-mcp.md §0):
 * sukces {ok:true,data,meta?}, błąd {ok:false,error:{code,message,details?,requestId}}.
 * Wyjątki od koperty: SSE i downloady plików.
 */

// ── Typy TS ─────────────────────────────────────────────────────────────────

export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  [key: string]: unknown;
}

export interface ApiSuccess<T = unknown> {
  ok: true;
  data: T;
  meta?: ApiMeta;
}

export interface ApiErrorBody {
  code: keyof typeof ERROR_CODES;
  message: string;
  details?: unknown;
  requestId: string;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export type ApiEnvelope<T = unknown> = ApiSuccess<T> | ApiFailure;

// ── JSON Schema (do fastify.addSchema / walidacji kontraktowej) ─────────────

export const successEnvelopeSchema = {
  $id: 'https://pomagierkb/schemas/envelope-success.json',
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'data'],
  properties: {
    ok: { const: true },
    data: {}, // kształt per trasa — trasy podstawiają własny schemat data
    meta: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1 },
        total: { type: 'integer', minimum: 0 },
      },
      additionalProperties: true,
    },
  },
} as const;

export const errorEnvelopeSchema = {
  $id: 'https://pomagierkb/schemas/envelope-error.json',
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'error'],
  properties: {
    ok: { const: false },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string', enum: Object.keys(ERROR_CODES) },
        message: { type: 'string' },
        details: {}, // dowolny kształt (np. lista checks preflight)
        requestId: { type: 'string' },
      },
    },
  },
} as const;
