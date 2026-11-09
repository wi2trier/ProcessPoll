import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorCode, errorI18nKey, isBusy, isRetryable, parseRetryAfter } from './apiErrors';
import { ApiError, exportUrl, request, streamUrl } from '../api/client';
import en from '../i18n/en.json';

describe('error mapping', () => {
  it('prefers known detail codes', () => {
    expect(errorCode(403, 'session_not_open')).toBe('session_not_open');
    expect(errorCode(409, 'already_submitted')).toBe('already_submitted');
    expect(errorCode(401, 'invalid_key')).toBe('invalid_key');
    expect(errorCode(422, 'validation_error')).toBe('validation_error');
    expect(errorCode(404, 'not_found')).toBe('not_found');
  });
  it('falls back to the status', () => {
    expect(errorCode(401)).toBe('unauthorized');
    expect(errorCode(403, 'something_new')).toBe('forbidden');
    expect(errorCode(404, null)).toBe('not_found');
    expect(errorCode(409, 'x')).toBe('conflict');
    expect(errorCode(429)).toBe('rate_limited');
    expect(errorCode(0)).toBe('network_error');
    expect(errorCode(500)).toBe('internal_error');
    expect(errorCode(502)).toBe('server_error');
    expect(errorCode(520)).toBe('server_error');
    expect(errorCode(418)).toBe('unknown');
  });
  it('knows the newer backend codes', () => {
    expect(errorCode(400, 'bad_request')).toBe('bad_request');
    expect(errorCode(413, 'payload_too_large')).toBe('payload_too_large');
    expect(errorCode(500, 'internal_error')).toBe('internal_error');
    expect(errorCode(503, 'busy')).toBe('busy');
    expect(errorCode(503)).toBe('busy');
    expect(errorCode(413)).toBe('payload_too_large');
    expect(errorCode(400)).toBe('bad_request');
    expect(errorCode(409, 'invalid_transition')).toBe('invalid_transition');
    expect(errorCode(409, 'questions_locked')).toBe('questions_locked');
    expect(errorCode(403, 'session_not_open')).toBe('session_not_open');
    expect(errorCode(429, 'rate_limited')).toBe('rate_limited');
  });
  it('recognises load shedding and parses Retry-After', () => {
    expect(isBusy(503)).toBe(true);
    expect(isBusy(500, 'busy')).toBe(true);
    expect(isBusy(500)).toBe(false);
    expect(parseRetryAfter('2')).toBe(2);
    expect(parseRetryAfter(' 1.5 ')).toBe(1.5);
    expect(parseRetryAfter('999')).toBe(60);
    expect(parseRetryAfter('-1')).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
  it('builds an i18n key that exists in the translations', () => {
    const cases: [number, string | undefined][] = [[0, undefined], [401, undefined], [403, 'session_not_open'], [404, 'not_found'], [409, 'invalid_transition'], [409, 'questions_locked'], [422, undefined], [429, 'too_many_requests'], [500, undefined], [418, undefined], [400, 'bad_request'], [413, 'payload_too_large'], [500, 'internal_error'], [503, 'busy'], [503, undefined]];
    for (const [s, d] of cases) {
      const key = errorI18nKey(s, d).replace('errors.', '');
      expect((en.errors as Record<string, string>)[key], `${s} ${d}`).toBeTruthy();
    }
  });
  it('marks network, 429 and 5xx as retryable', () => {
    expect(isRetryable(0)).toBe(true);
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    expect(isRetryable(422)).toBe(false);
    expect(isRetryable(409)).toBe(false);
  });
});

describe('request()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns a network failure into ApiError(0)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    await expect(request('/x')).rejects.toMatchObject({ status: 0, detail: 'network_error' });
  });
  it('parses error bodies including per-question errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'validation_error', message: 'bad', errors: [{ question_id: 'q1', message: 'too short' }] }), { status: 422 })));
    try {
      await request('/x');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(422);
      expect(err.errors).toEqual([{ question_id: 'q1', message: 'too short' }]);
      expect(err.i18nKey).toBe('errors.validation_error');
    }
  });
  it('normalises FastAPI list-style detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: [{ loc: ['body'], msg: 'x' }] }), { status: 422 })));
    await expect(request('/x')).rejects.toMatchObject({ status: 422, detail: 'validation_error' });
  });
  it('survives non-JSON error bodies and sends auth headers', async () => {
    const f = vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    vi.stubGlobal('fetch', f);
    await expect(request('/x', { auth: { kind: 'admin', key: 'K' } })).rejects.toMatchObject({ status: 502 });
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'X-Admin-Key': 'K' });
  });
  it('returns undefined for 204 and parses JSON otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response('{"a":1}', { status: 200 })));
    expect(await request('/x')).toBeUndefined();
    expect(await request('/y')).toEqual({ a: 1 });
  });
  it('keeps the Retry-After header on 503 busy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'busy', message: 'busy' }), { status: 503, headers: { 'Retry-After': '2' } })));
    await expect(request('/x')).rejects.toMatchObject({ status: 503, detail: 'busy', retryAfter: 2 });
  });
  it('builds export and stream urls with the key', () => {
    expect(exportUrl('morn-24', 'k 1', 'csv', 'q1')).toBe('/api/v1/sessions/MORN-24/export?format=csv&key=k+1&question_id=q1');
    expect(exportUrl('MORN-24', 'k', 'json', 'q1')).not.toContain('question_id');
    expect(streamUrl('MORN-24', 'abc')).toBe('/api/v1/sessions/MORN-24/stream?key=abc');
    expect(streamUrl('MORN-24')).toBe('/api/v1/sessions/MORN-24/stream');
  });
});
