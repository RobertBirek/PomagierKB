/** Katalog kodów błędów API (koperta {ok:false, error:{code,...}}). */
export const ERROR_CODES = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  csrf_rejected: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  action_already_running: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  fetch_blocked: 422, // safe_http: URL/IP/typ treści odrzucony polityką (SSRF fail-closed)
  fetch_failed: 502, // safe_http: DNS/połączenie/HTTP != 2xx/timeout
  fetch_too_large: 413, // safe_http: przekroczony cap rozmiaru streamu
  preflight_failed: 422,
  rate_limited: 429,
  internal: 500,
  upstream_error: 502,
  not_ready: 503,
  upstream_timeout: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_CODES[code];
    this.details = details;
  }
}

/** Błąd upstreamu (OpenSPG/LLM/Stirling/Tika) z kontekstem dla koperty. */
export class UpstreamError extends AppError {
  constructor(service: string, endpoint: string, status: number | undefined, message: string) {
    super('upstream_error', message, { service, endpoint, status });
  }
}
