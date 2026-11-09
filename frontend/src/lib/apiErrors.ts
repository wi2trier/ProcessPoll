const KNOWN_DETAILS = new Set([
  'bad_request',
  'session_not_open',
  'already_submitted',
  'invalid_key',
  'invalid_token',
  'validation_error',
  'not_found',
  'invalid_transition',
  'questions_locked',
  'payload_too_large',
  'rate_limited',
  'internal_error',
  'busy',
  'network_error',
  'too_many_requests',
]);

const STATUS_FALLBACK: Record<number, string> = {
  0: 'network_error',
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  422: 'validation_error',
  429: 'rate_limited',
  500: 'internal_error',
  502: 'server_error',
  503: 'busy',
  504: 'server_error',
};

export function errorCode(status: number, detail?: string | null): string {
  if (detail === 'too_many_requests') return 'rate_limited';
  if (detail && KNOWN_DETAILS.has(detail)) return detail;
  if (STATUS_FALLBACK[status]) return STATUS_FALLBACK[status];
  if (status >= 500) return 'server_error';
  return 'unknown';
}

export function errorI18nKey(status: number, detail?: string | null): string {
  return `errors.${errorCode(status, detail)}`;
}

export function isRetryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export function isBusy(status: number, detail?: string | null): boolean {
  return status === 503 || detail === 'busy';
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const s = Number(value.trim());
  if (!Number.isFinite(s) || s < 0) return undefined;
  return Math.min(60, s);
}
