import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { retryDelayMs, shouldRetry } from './retry';

const err = (status: number, retryAfter?: number) => new ApiError(status, { detail: 'x' }, retryAfter);

describe('shouldRetry', () => {
  it('waits out 503 busy for a long time', () => {
    expect(shouldRetry(0, err(503))).toBe(true);
    expect(shouldRetry(7, err(503))).toBe(true);
    expect(shouldRetry(8, err(503))).toBe(false);
  });
  it('retries 429 and other server errors only twice', () => {
    for (const s of [429, 500, 502, 504, 0]) {
      expect(shouldRetry(1, err(s)), String(s)).toBe(true);
      expect(shouldRetry(2, err(s)), String(s)).toBe(false);
    }
  });
  it('never retries client errors', () => {
    for (const s of [400, 401, 403, 404, 409, 413, 422]) expect(shouldRetry(0, err(s)), String(s)).toBe(false);
  });
  it('retries unknown (non-API) errors twice', () => {
    expect(shouldRetry(1, new Error('boom'))).toBe(true);
    expect(shouldRetry(2, new Error('boom'))).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('honours Retry-After (clamped) plus a little jitter', () => {
    expect(retryDelayMs(0, err(503, 2), () => 0)).toBe(2000);
    expect(retryDelayMs(3, err(503, 2), () => 1)).toBe(2250);
    expect(retryDelayMs(0, err(503, 0), () => 0)).toBe(500);
    expect(retryDelayMs(0, err(503, 600), () => 0)).toBe(30000);
  });
  it('falls back to exponential backoff', () => {
    expect([0, 1, 2, 3, 4, 5].map((a) => retryDelayMs(a, err(500)))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(retryDelayMs(1, new Error('x'))).toBe(2000);
  });
});
