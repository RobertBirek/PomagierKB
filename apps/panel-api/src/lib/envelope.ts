import type { ApiErrorBody, ApiFailure } from '@pomagierkb/shared/schemas';
import type { ErrorCode } from '@pomagierkb/shared/errors';

/** Buduje kopertę błędu {ok:false,error:{code,message,details?,requestId}}. */
export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ApiFailure {
  const error: ApiErrorBody = { code, message, requestId };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}
