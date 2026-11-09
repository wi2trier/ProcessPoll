import { describe, expect, it } from 'vitest';
import type { NumberConfig } from '../api/types';
import { moveItem, newQuestion, optionalSectionOpen, parseLines, parseNumberList, previewTexts, toQuestionsIn, validateBuilder, morningDescription, morningTemplate } from './builder';

const t = (k: string) => k;

describe('builder', () => {
  it('parses lines', () => {
    expect(parseLines(' a \n\n b  c \r\nd')).toEqual(['a', 'b c', 'd']);
  });
  it('parses number lists', () => {
    expect(parseNumberList('18, 25 40')).toEqual([18, 25, 40]);
    expect(parseNumberList('')).toBeNull();
    expect(parseNumberList('1, x')?.some((n) => Number.isNaN(n))).toBe(true);
  });
  it('moves items', () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });
  it('validates title, prompts and options', () => {
    const q = newQuestion('single_choice');
    const codes = validateBuilder('', [q]).map((i) => i.code);
    expect(codes).toContain('title_required');
    expect(codes).toContain('prompt_required');
    expect(codes).toContain('options_min');
    expect(validateBuilder('T', []).map((i) => i.code)).toEqual(['no_questions']);
  });
  it('validates a select_sort pool and step range', () => {
    const q = newQuestion('trace', 'P');
    q.config = { ...(q.config as object), mode: 'select_sort', activities: ['A'] } as typeof q.config;
    expect(validateBuilder('T', [q]).map((i) => i.code)).toContain('pool_min');
    const q2 = newQuestion('trace', 'P');
    q2.config = { ...(q2.config as object), min_steps: 5, max_steps: 3 } as typeof q2.config;
    expect(validateBuilder('T', [q2]).map((i) => i.code)).toContain('steps_range');
  });
  it('validates number bins', () => {
    const q = newQuestion('number', 'Age');
    (q.config as NumberConfig).bins = [10, 5];
    expect(validateBuilder('T', [q]).map((i) => i.code)).toContain('bins_invalid');
    (q.config as NumberConfig).bins = [5, 10];
    expect(validateBuilder('T', [q])).toEqual([]);
  });
  it('accepts the morning template and serialises it cleanly', () => {
    const qs = morningTemplate(t);
    expect(qs).toHaveLength(3);
    expect(qs[0].type).toBe('trace');
    expect(validateBuilder('Title', qs)).toEqual([]);
    const out = toQuestionsIn(qs);
    expect(out[0]).not.toHaveProperty('uid');
    expect(out[1].config).toEqual({ options: ['templates.morning.roleStudent', 'templates.morning.roleLecturer', 'templates.morning.roleOther'] });
  });
  it('drops blank options and unused pools when serialising', () => {
    const c = newQuestion('single_choice', 'Q');
    c.config = { options: ['a', ' ', 'b', ''] };
    expect(toQuestionsIn([c])[0].config).toEqual({ options: ['a', 'b'] });
    const tr = newQuestion('trace', 'Q');
    tr.config = { ...(tr.config as object), mode: 'free', activities: ['x'] } as typeof tr.config;
    expect((toQuestionsIn([tr])[0].config as { activities: string[] }).activities).toEqual([]);
  });
});

describe('question text and field label', () => {
  it('serialises the label (trimmed, empty becomes null) and the question text separately', () => {
    const q = newQuestion('single_choice', '  What is your current role?  ');
    q.label = '  Role ';
    q.config = { options: ['a', 'b'] };
    const q2 = newQuestion('number', 'How old are you?');
    q2.label = '   ';
    const out = toQuestionsIn([q, q2]);
    expect(out[0]).toMatchObject({ prompt: 'What is your current role?', label: 'Role' });
    expect(out[1]).toMatchObject({ prompt: 'How old are you?', label: null });
  });
  it('validates the length limits of label (80) and description (1000)', () => {
    const q = newQuestion('text', 'Q?');
    q.label = 'x'.repeat(81);
    const codes = validateBuilder('T', [q], 'y'.repeat(1001)).map((i) => i.code);
    expect(codes).toContain('label_too_long');
    expect(codes).toContain('description_too_long');
    q.label = 'x'.repeat(80);
    expect(validateBuilder('T', [q], 'y'.repeat(1000))).toEqual([]);
  });
  it('still requires the question itself, a label alone is not enough', () => {
    const q = newQuestion('text', '');
    q.label = 'Role';
    expect(validateBuilder('T', [q]).map((i) => i.code)).toContain('prompt_required');
  });
  it('opens the "Optional" section only when it already has values', () => {
    expect(optionalSectionOpen({ label: null, help: null })).toBe(false);
    expect(optionalSectionOpen({ label: '  ', help: '' })).toBe(false);
    expect(optionalSectionOpen({ label: 'Role', help: null })).toBe(true);
    expect(optionalSectionOpen({ label: null, help: 'Pick one' })).toBe(true);
  });
  it('previews what participants see and what the presentation shows', () => {
    expect(previewTexts({ prompt: ' What is your current role? ', label: 'Role' })).toEqual({ participants: 'What is your current role?', presentation: 'Role' });
    expect(previewTexts({ prompt: 'What is your current role?', label: '' })).toEqual({ participants: 'What is your current role?', presentation: 'What is your current role?' });
  });
  it('fills the template with questions and short labels', () => {
    const qs = morningTemplate((k) => k);
    expect(qs.map((q) => q.label)).toEqual(['templates.morning.promptLabel', 'templates.morning.role', 'templates.morning.experience']);
    expect(qs.map((q) => q.prompt)).toEqual(['templates.morning.prompt', 'templates.morning.roleQuestion', 'templates.morning.experienceQuestion']);
    expect(morningDescription((k) => k)).toBe('templates.morning.description');
  });
});
