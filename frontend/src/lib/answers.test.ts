import { describe, expect, it } from 'vitest';
import type { Question } from '../api/types';
import { buildAnswers, emptyAnswer, isAnswered } from './answers';
import { DEFAULT_TRACE_CONFIG } from './traceLogic';

const qs: Question[] = [
  { id: 't', position: 0, type: 'trace', prompt: 'P', help: null, required: true, config: { ...DEFAULT_TRACE_CONFIG } },
  { id: 'r', position: 1, type: 'single_choice', prompt: 'Role', help: null, required: false, config: { options: ['Student', 'Lecturer'] } },
  { id: 'm', position: 2, type: 'multiple_choice', prompt: 'M', help: null, required: false, config: { options: ['a', 'b', 'c'], max_selected: 2 } },
  { id: 'n', position: 3, type: 'number', prompt: 'N', help: null, required: false, config: { integer: true, min: 0, max: 10 } },
  { id: 'x', position: 4, type: 'text', prompt: 'X', help: null, required: false, config: { max_length: 5 } },
];

describe('buildAnswers', () => {
  it('builds a payload with nulls for optional unanswered questions', () => {
    const { answers, errors } = buildAnswers(qs, { t: ['Wake up', ' Coffee '], r: 'Student' });
    expect(errors).toEqual({});
    expect(answers).toEqual([
      { question_id: 't', value: { steps: ['Wake up', 'Coffee'] } },
      { question_id: 'r', value: { value: 'Student' } },
      { question_id: 'm', value: null },
      { question_id: 'n', value: null },
      { question_id: 'x', value: null },
    ]);
  });
  it('flags missing required questions and short traces', () => {
    expect(buildAnswers(qs, {}).errors.t.code).toBe('required');
    expect(buildAnswers(qs, { t: ['one'] }).errors.t).toMatchObject({ code: 'trace_min_steps', params: { min: 2 } });
  });
  it('validates choice, number and text', () => {
    const base = { t: ['a', 'b'] };
    expect(buildAnswers(qs, { ...base, r: 'Other' }).errors.r.code).toBe('invalid_option');
    expect(buildAnswers(qs, { ...base, m: ['a', 'b', 'c'] }).errors.m.code).toBe('too_many_selected');
    expect(buildAnswers(qs, { ...base, n: '11' }).errors.n.code).toBe('number_max');
    expect(buildAnswers(qs, { ...base, n: '-1' }).errors.n.code).toBe('number_min');
    expect(buildAnswers(qs, { ...base, n: '1.5' }).errors.n.code).toBe('number_integer');
    expect(buildAnswers(qs, { ...base, n: 'abc' }).errors.n.code).toBe('invalid_number');
    expect(buildAnswers(qs, { ...base, n: '7' }).answers[3].value).toEqual({ value: 7 });
    expect(buildAnswers(qs, { ...base, x: 'too long' }).errors.x.code).toBe('text_too_long');
  });
  it('helpers', () => {
    expect(emptyAnswer(qs[0])).toEqual([]);
    expect(emptyAnswer(qs[1])).toBe('');
    expect(isAnswered('  ')).toBe(false);
    expect(isAnswered(['a'])).toBe(true);
    expect(isAnswered(undefined)).toBe(false);
  });
});
