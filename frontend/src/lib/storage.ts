import type { StoredSession } from '../api/types';

export function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function safeSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
export function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

const SESSIONS_KEY = 'processpoll:host-sessions';

function isStoredSession(x: unknown): x is StoredSession {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.code === 'string' && typeof o.admin_key === 'string';
}

export function listStoredSessions(): StoredSession[] {
  const raw = safeGet(SESSIONS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredSession).map((s) => ({
      code: s.code,
      admin_key: s.admin_key,
      display_key: typeof s.display_key === 'string' ? s.display_key : '',
      title: typeof s.title === 'string' ? s.title : s.code,
      created_at: typeof s.created_at === 'string' ? s.created_at : '',
    }));
  } catch {
    return [];
  }
}

export function saveStoredSession(s: StoredSession): boolean {
  const others = listStoredSessions().filter((x) => x.code !== s.code);
  return safeSet(SESSIONS_KEY, JSON.stringify([s, ...others]));
}

export function removeStoredSession(code: string): void {
  const rest = listStoredSessions().filter((x) => x.code !== code);
  safeSet(SESSIONS_KEY, JSON.stringify(rest));
}

export function findStoredSession(code: string): StoredSession | undefined {
  const c = code.toUpperCase();
  return listStoredSessions().find((s) => s.code.toUpperCase() === c);
}

export interface ParticipantState {
  token?: string;
  draft?: Record<string, unknown>;
  idempotencyKey?: string;
  submitted?: boolean;
}

const pKey = (code: string) => `processpoll:participant:${code.toUpperCase()}`;

export function loadParticipant(code: string): ParticipantState {
  const raw = safeGet(pKey(code));
  if (!raw) return {};
  try {
    const p: unknown = JSON.parse(raw);
    return p && typeof p === 'object' ? (p as ParticipantState) : {};
  } catch {
    return {};
  }
}

export function saveParticipant(code: string, patch: Partial<ParticipantState>): void {
  const cur = loadParticipant(code);
  safeSet(pKey(code), JSON.stringify({ ...cur, ...patch }));
}

export function clearDraft(code: string): void {
  const cur = loadParticipant(code);
  delete cur.draft;
  delete cur.idempotencyKey;
  safeSet(pKey(code), JSON.stringify(cur));
}
