import { errorI18nKey, parseRetryAfter } from '../lib/apiErrors';
import type {
  AdminSession,
  AliasIn,
  AnswerIn,
  ApiErrorBody,
  Analytics,
  Compare,
  CreateSessionIn,
  CreateSessionOut,
  JoinOut,
  LabelsOut,
  Meta,
  PatchQuestionIn,
  PatchSessionIn,
  PublicSession,
  QuestionIn,
  SubmitOut,
} from './types';

export const API = '/api/v1';

export class ApiError extends Error {
  status: number;
  detail: string | undefined;
  errors: { question_id?: string; field?: string; message: string }[];

  retryAfter: number | undefined;
  constructor(status: number, body?: ApiErrorBody | null, retryAfter?: number) {
    super(body?.message || body?.detail || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = body?.detail;
    this.errors = Array.isArray(body?.errors) ? body.errors : [];
    this.retryAfter = retryAfter;
  }
  get i18nKey(): string {
    return errorI18nKey(this.status, this.detail);
  }
}

export interface Auth {
  kind: 'admin' | 'display';
  key: string;
}

function authHeaders(auth?: Auth | null): Record<string, string> {
  if (!auth?.key) return {};
  return auth.kind === 'admin' ? { 'X-Admin-Key': auth.key } : { 'X-Display-Key': auth.key };
}

interface ReqOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: Auth | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined | null>;
}

function buildQuery(q?: ReqOpts['query']): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function request<T>(path: string, opts: ReqOpts = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeaders(opts.auth),
    ...opts.headers,
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API}${path}${buildQuery(opts.query)}`, {
      method: opts.method ?? 'GET',
      headers,
      body,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, { detail: 'network_error', message: 'Network error' });
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    const b = data && typeof data === 'object' ? (data as ApiErrorBody) : null;

    if (b && Array.isArray((b as { detail?: unknown }).detail)) {
      throw new ApiError(res.status, { detail: 'validation_error', message: 'Validation error' }, retryAfter);
    }
    throw new ApiError(res.status, b, retryAfter);
  }
  return data as T;
}

const enc = encodeURIComponent;
const c = (code: string) => enc(code.toUpperCase());

export interface AnalyticsParams {
  question_id: string;
  filter_question_id?: string;
  filter_value?: string;
  min_support?: number;
  theta?: number;
}

export const api = {
  meta: () => request<Meta>('/meta'),

  createSession: (body: CreateSessionIn) => request<CreateSessionOut>('/sessions', { method: 'POST', body }),
  getSession: (code: string) => request<PublicSession>(`/sessions/${c(code)}`),
  getAdminSession: (code: string, auth: Auth) => request<AdminSession>(`/sessions/${c(code)}/admin`, { auth }),
  patchSession: (code: string, auth: Auth, body: PatchSessionIn) =>
    request<AdminSession>(`/sessions/${c(code)}`, { method: 'PATCH', auth, body }),
  putQuestions: (code: string, auth: Auth, questions: QuestionIn[]) =>
    request<AdminSession>(`/sessions/${c(code)}/questions`, { method: 'PUT', auth, body: { questions } }),

  patchQuestion: (code: string, auth: Auth, questionId: string, body: PatchQuestionIn) =>
    request<AdminSession>(`/sessions/${c(code)}/questions/${enc(questionId)}`, { method: 'PATCH', auth, body }),
  deleteSession: (code: string, auth: Auth) => request<void>(`/sessions/${c(code)}`, { method: 'DELETE', auth }),

  join: (code: string, token?: string) =>
    request<JoinOut>(`/sessions/${c(code)}/join`, { method: 'POST', body: token ? { token } : {} }),
  submit: (code: string, token: string, idempotencyKey: string, answers: AnswerIn[]) =>
    request<SubmitOut>(`/sessions/${c(code)}/responses`, {
      method: 'POST',
      body: { answers },
      headers: { 'X-Participant-Token': token, 'Idempotency-Key': idempotencyKey },
    }),

  suggestLabels: (code: string, questionId: string, q: string) =>
    request<{ labels: string[] }>(`/sessions/${c(code)}/labels/suggest`, { query: { question_id: questionId, q } }).then((r) => r.labels ?? []),
  getLabels: (code: string, auth: Auth, questionId: string) =>
    request<LabelsOut>(`/sessions/${c(code)}/labels`, { auth, query: { question_id: questionId } }),
  putAliases: (code: string, auth: Auth, questionId: string, aliases: AliasIn[]) =>
    request<{ ok: boolean; version: number }>(`/sessions/${c(code)}/aliases`, {
      method: 'PUT',
      auth,
      body: { question_id: questionId, aliases },
    }),

  getAnalytics: (code: string, auth: Auth | null, p: AnalyticsParams, signal?: AbortSignal) =>
    request<Analytics>(`/sessions/${c(code)}/analytics`, {
      auth,
      signal,
      query: { ...p },
    }),
  getCompare: (code: string, auth: Auth | null, questionId: string, groupBy: string, signal?: AbortSignal) =>
    request<Compare>(`/sessions/${c(code)}/compare`, {
      auth,
      signal,
      query: { question_id: questionId, group_by: groupBy },
    }),
};

export function exportUrl(code: string, key: string, format: 'csv' | 'xes' | 'json', questionId?: string): string {
  const p = new URLSearchParams({ format, key });
  if (questionId && format !== 'json') p.set('question_id', questionId);
  return `${API}/sessions/${c(code)}/export?${p.toString()}`;
}

export function streamUrl(code: string, key?: string | null): string {
  const q = key ? `?key=${enc(key)}` : '';
  return `${API}/sessions/${c(code)}/stream${q}`;
}
