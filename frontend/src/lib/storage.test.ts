import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDraft,
  findStoredSession,
  listStoredSessions,
  loadParticipant,
  removeStoredSession,
  safeGet,
  safeSet,
  saveParticipant,
  saveStoredSession,
} from './storage';

const s = (code: string, extra = {}) => ({ code, admin_key: 'A' + code, display_key: 'D' + code, title: 'T ' + code, created_at: '2026-01-01T00:00:00Z', ...extra });

describe('stored host sessions', () => {
  beforeEach(() => window.localStorage.clear());

  it('starts empty', () => expect(listStoredSessions()).toEqual([]));

  it('saves newest first and replaces by code', () => {
    expect(saveStoredSession(s('AAAA-11'))).toBe(true);
    saveStoredSession(s('BBBB-22'));
    saveStoredSession(s('AAAA-11', { title: 'renamed' }));
    const l = listStoredSessions();
    expect(l.map((x) => x.code)).toEqual(['AAAA-11', 'BBBB-22']);
    expect(l[0].title).toBe('renamed');
  });

  it('removes and finds case-insensitively', () => {
    saveStoredSession(s('AAAA-11'));
    saveStoredSession(s('BBBB-22'));
    expect(findStoredSession('bbbb-22')?.admin_key).toBe('ABBBB-22');
    removeStoredSession('AAAA-11');
    expect(listStoredSessions().map((x) => x.code)).toEqual(['BBBB-22']);
  });

  it('ignores corrupt data', () => {
    window.localStorage.setItem('processpoll:host-sessions', '{not json');
    expect(listStoredSessions()).toEqual([]);
    window.localStorage.setItem('processpoll:host-sessions', JSON.stringify([{ foo: 1 }, s('CCCC-33'), 'x']));
    expect(listStoredSessions().map((x) => x.code)).toEqual(['CCCC-33']);
    window.localStorage.setItem('processpoll:host-sessions', '{"a":1}');
    expect(listStoredSessions()).toEqual([]);
  });
});

describe('participant state', () => {
  beforeEach(() => window.localStorage.clear());
  it('stores token and draft per code, case-insensitive', () => {
    saveParticipant('morn-24', { token: 't1' });
    saveParticipant('MORN-24', { draft: { q: ['a'] } });
    expect(loadParticipant('Morn-24')).toEqual({ token: 't1', draft: { q: ['a'] } });
    expect(loadParticipant('OTHER-99')).toEqual({});
    clearDraft('MORN-24');
    expect(loadParticipant('MORN-24')).toEqual({ token: 't1' });
  });
});

describe('when localStorage is unavailable', () => {
  const orig = Object.getOwnPropertyDescriptor(window, 'localStorage');
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  afterEach(() => {
    if (orig) Object.defineProperty(window, 'localStorage', orig);
    else delete (window as unknown as Record<string, unknown>).localStorage;
    vi.restoreAllMocks();
  });

  it('never throws and degrades gracefully', () => {
    expect(safeGet('x')).toBeNull();
    expect(safeSet('x', 'y')).toBe(false);
    expect(listStoredSessions()).toEqual([]);
    expect(saveStoredSession(s('AAAA-11'))).toBe(false);
    expect(() => removeStoredSession('AAAA-11')).not.toThrow();
    expect(findStoredSession('AAAA-11')).toBeUndefined();
    expect(loadParticipant('AAAA-11')).toEqual({});
    expect(() => saveParticipant('AAAA-11', { token: 'x' })).not.toThrow();
    expect(() => clearDraft('AAAA-11')).not.toThrow();
  });

  it('reports a quota error on write', () => {
    if (orig) Object.defineProperty(window, 'localStorage', orig);
    else delete (window as unknown as Record<string, unknown>).localStorage;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(saveStoredSession(s('AAAA-11'))).toBe(false);
  });
});
