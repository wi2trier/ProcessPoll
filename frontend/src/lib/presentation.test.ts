import { describe, expect, it } from 'vitest';
import { emptyToNull, groupByName, presentationName } from './presentation';

describe('presentationName', () => {
  it('uses the field label when there is one', () => {
    expect(presentationName({ prompt: 'What is your current role?', label: 'Role' })).toBe('Role');
  });
  it('falls back to the question when the label is missing, null or blank', () => {
    expect(presentationName({ prompt: 'What is your current role?' })).toBe('What is your current role?');
    expect(presentationName({ prompt: 'Q?', label: null })).toBe('Q?');
    expect(presentationName({ prompt: 'Q?', label: '' })).toBe('Q?');
    expect(presentationName({ prompt: 'Q?', label: '   ' })).toBe('Q?');
  });
  it('trims the label', () => {
    expect(presentationName({ prompt: 'Q?', label: '  Role ' })).toBe('Role');
  });
  it('applies the same rule to the compare group_by', () => {
    expect(groupByName({ prompt: 'What is your role?', label: 'Role' })).toBe('Role');
    expect(groupByName({ prompt: 'What is your role?', label: null })).toBe('What is your role?');
  });
});

describe('emptyToNull', () => {
  it('trims and turns empty text into null', () => {
    expect(emptyToNull('  hi ')).toBe('hi');
    expect(emptyToNull('')).toBeNull();
    expect(emptyToNull('   ')).toBeNull();
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull(undefined)).toBeNull();
  });
});
