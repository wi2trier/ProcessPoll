import { describe, expect, it } from 'vitest';
import { isPlausibleJoinCode, normalizeJoinCode } from './joinCode';

describe('normalizeJoinCode', () => {
  it('upper-cases', () => expect(normalizeJoinCode('morn-24')).toBe('MORN-24'));
  it('inserts the dash when missing', () => expect(normalizeJoinCode('morn24')).toBe('MORN-24'));
  it('removes whitespace', () => {
    expect(normalizeJoinCode('  MORN 24 ')).toBe('MORN-24');
    expect(normalizeJoinCode('mo rn - 24')).toBe('MORN-24');
  });
  it('accepts unicode dashes', () => expect(normalizeJoinCode('MORN\u201324')).toBe('MORN-24'));
  it('extracts the code from a pasted link', () => {
    expect(normalizeJoinCode('https://poll.example.org/j/morn-24?x=1')).toBe('MORN-24');
    expect(normalizeJoinCode('http://localhost:5173/p/abcd-12')).toBe('ABCD-12');
  });
  it('handles empty input', () => expect(normalizeJoinCode('')).toBe(''));
  it('validates plausibility', () => {
    expect(isPlausibleJoinCode('MORN-24')).toBe(true);
    expect(isPlausibleJoinCode('MORN')).toBe(false);
    expect(isPlausibleJoinCode('')).toBe(false);
    expect(isPlausibleJoinCode('A B-1')).toBe(false);
  });
});
