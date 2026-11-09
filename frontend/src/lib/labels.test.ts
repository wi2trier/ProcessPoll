import { describe, expect, it } from 'vitest';
import { displayName, unmaskLabel } from './labels';

describe('masked labels', () => {
  it('removes the masking backslash from literal __start__ / __end__ labels only', () => {
    expect(unmaskLabel('\\__start__')).toBe('__start__');
    expect(unmaskLabel('\\__end__')).toBe('__end__');
    expect(unmaskLabel('__start__')).toBe('__start__');
    expect(unmaskLabel('\\other')).toBe('\\other');
    expect(unmaskLabel('Wake up')).toBe('Wake up');
  });
  it('shows translated names for the virtual nodes and unmasked text for the rest', () => {
    expect(displayName('__start__', 'Start', 'End')).toBe('Start');
    expect(displayName('__end__', 'Start', 'End')).toBe('End');
    expect(displayName('\\__start__', 'Start', 'End')).toBe('__start__');
    expect(displayName('Coffee', 'Start', 'End')).toBe('Coffee');
  });
});
