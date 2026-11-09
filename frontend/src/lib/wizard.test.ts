import { describe, expect, it } from 'vitest';
import type { Question } from '../api/types';
import { canSkip, deriveSteps, firstInvalidStep, primaryAction, progress, validateStep } from './wizard';
import { DEFAULT_TRACE_CONFIG } from './traceLogic';

const mk = (id: string, position: number, type: Question['type'], required: boolean, config: Question['config']): Question => ({ id, position, type, prompt: id, help: null, required, config });
const qs: Question[] = [
  mk('role', 1, 'single_choice', false, { options: ['A', 'B'] }),
  mk('trace', 0, 'trace', true, { ...DEFAULT_TRACE_CONFIG }),
  mk('age', 2, 'number', true, { integer: true, min: 0, max: 120 }),
];

describe('wizard', () => {
  it('derives one step per question in position order', () => {
    const s = deriveSteps(qs);
    expect(s.map((x) => x.question.id)).toEqual(['trace', 'role', 'age']);
    expect(s.map((x) => x.optional)).toEqual([false, true, false]);
  });
  it('validates only the current step', () => {
    const [trace, role, age] = deriveSteps(qs);
    expect(validateStep(trace, {})?.code).toBe('required');
    expect(validateStep(trace, { trace: ['a'] })?.code).toBe('trace_min_steps');
    expect(validateStep(trace, { trace: ['a', 'b'] })).toBeUndefined();
    expect(validateStep(role, {})).toBeUndefined();
    expect(validateStep(role, { role: 'Z' })?.code).toBe('invalid_option');
    expect(validateStep(age, { age: '200' })?.code).toBe('number_max');
    expect(validateStep(age, { age: '30' })).toBeUndefined();
  });
  it('offers skip only for unanswered optional questions', () => {
    const [trace, role] = deriveSteps(qs);
    expect(canSkip(trace, {})).toBe(false);
    expect(canSkip(role, {})).toBe(true);
    expect(canSkip(role, { role: 'A' })).toBe(false);
  });
  it('switches the primary action on the last step', () => {
    expect(primaryAction(0, 3)).toBe('next');
    expect(primaryAction(2, 3)).toBe('submit');
    expect(primaryAction(0, 1)).toBe('submit');
  });
  it('computes progress', () => {
    expect(progress(0, 4)).toBe(0.25);
    expect(progress(3, 4)).toBe(1);
    expect(progress(0, 0)).toBe(0);
    expect(progress(9, 4)).toBe(1);
  });
  it('finds the first invalid step', () => {
    const steps = deriveSteps(qs);
    expect(firstInvalidStep(steps, { trace: ['a', 'b'], age: '10' })).toBe(-1);
    expect(firstInvalidStep(steps, { trace: ['a', 'b'] })).toBe(2);
    expect(firstInvalidStep(steps, {})).toBe(0);
  });
});
