import { ApiError } from '../api/client';

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (!(error instanceof ApiError)) return failureCount < 2;
  if (error.status === 503) return failureCount < 8;
  if (error.status === 429) return failureCount < 2;
  if (error.status === 0 || error.status >= 500) return failureCount < 2;
  return false;
}

export function retryDelayMs(attempt: number, error: unknown, jitter: () => number = Math.random): number {
  const ra = error instanceof ApiError ? error.retryAfter : undefined;
  if (ra != null) return Math.round(Math.max(0.5, Math.min(30, ra)) * 1000 + jitter() * 250);
  return Math.min(8000, 1000 * 2 ** attempt);
}
