import { describe, expect, it } from 'vitest';
import {
  addStep,
  checkLabel,
  cleanLabel,
  labelKey,
  makeItems,
  moveStep,
  poolChipState,
  removeStep,
  repeatedIndices,
  suggestLabels,
  toSteps,
  validateTrace,
  withTraceDefaults,
  DEFAULT_TRACE_CONFIG,
} from './traceLogic';

let n = 0;
const id = () => `id${++n}`;
const cfg = (p = {}) => withTraceDefaults(p);

describe('traceLogic', () => {
  it('cleans and keys labels', () => {
    expect(cleanLabel('  Wake   up \n')).toBe('Wake up');
    expect(labelKey(' Wake  UP. ')).toBe('wake up');
    expect(labelKey('Café!')).toBe('café');
  });

  it('applies defaults for missing config fields', () => {
    const c = withTraceDefaults({ mode: 'select_sort' });
    expect(c.mode).toBe('select_sort');
    expect(c.max_steps).toBe(DEFAULT_TRACE_CONFIG.max_steps);
    expect(c.activities).toEqual([]);
    expect(withTraceDefaults(undefined).allow_repeats).toBe(true);
  });

  it('adds trimmed steps and rejects empty ones', () => {
    let r = addStep([], '  Wake   up ', cfg(), id);
    expect(toSteps(r.items)).toEqual(['Wake up']);
    r = addStep(r.items, '   ', cfg(), id);
    expect(r.error).toBe('empty');
    expect(r.items).toHaveLength(1);
  });

  it('prevents duplicates (case/punctuation-insensitive) only when repeats are off', () => {
    const items = makeItems(['Coffee'], id);
    expect(addStep(items, 'coffee.', cfg({ allow_repeats: false }), id).error).toBe('duplicate');
    expect(addStep(items, 'coffee', cfg({ allow_repeats: true }), id).items).toHaveLength(2);
  });

  it('enforces max steps and label length', () => {
    const items = makeItems(['a', 'b'], id);
    expect(addStep(items, 'c', cfg({ max_steps: 2 }), id).error).toBe('max_steps');
    expect(checkLabel([], 'x'.repeat(11), cfg({ max_label_length: 10 }))).toBe('too_long');
    expect(checkLabel([], 'x'.repeat(10), cfg({ max_label_length: 10 }))).toBeUndefined();
  });

  it('removes and moves steps', () => {
    const items = makeItems(['a', 'b', 'c'], id);
    expect(toSteps(removeStep(items, 1))).toEqual(['a', 'c']);
    expect(removeStep(items, 9)).toBe(items);
    expect(toSteps(moveStep(items, 0, 2))).toEqual(['b', 'c', 'a']);
    expect(toSteps(moveStep(items, 2, 1))).toEqual(['a', 'c', 'b']);
    expect(moveStep(items, 0, -1)).toBe(items);
    expect(moveStep(items, 0, 3)).toBe(items);

    expect(toSteps(items)).toEqual(['a', 'b', 'c']);
  });

  it('finds repeated indices', () => {
    const items = makeItems(['A', 'b', 'a'], id);
    expect([...repeatedIndices(items)].sort()).toEqual([0, 2]);
  });

  describe('select_sort pool', () => {
    const c = cfg({ mode: 'select_sort', activities: ['A', 'B'], allow_repeats: false });
    it('disables used chips when repeats are off', () => {
      const items = makeItems(['A'], id);
      expect(poolChipState('A', items, c)).toEqual({ used: 1, disabled: true });
      expect(poolChipState('B', items, c)).toEqual({ used: 0, disabled: false });
    });
    it('keeps chips enabled with repeats until max steps', () => {
      const c2 = cfg({ mode: 'select_sort', activities: ['A'], allow_repeats: true, max_steps: 2 });
      expect(poolChipState('A', makeItems(['A'], id), c2).disabled).toBe(false);
      expect(poolChipState('A', makeItems(['A', 'A'], id), c2).disabled).toBe(true);
    });
  });

  describe('validateTrace', () => {
    it('requires steps when required', () => {
      expect(validateTrace([], cfg(), true)).toEqual(['required']);
      expect(validateTrace([], cfg(), false)).toEqual([]);
    });
    it('checks min steps', () => {
      expect(validateTrace(makeItems(['a'], id), cfg({ min_steps: 2 }), true)).toContain('min_steps');
    });
    it('checks pool membership for select_sort without custom', () => {
      const c = cfg({ mode: 'select_sort', activities: ['A', 'B'], min_steps: 1 });
      expect(validateTrace(makeItems(['A', 'x'], id), c, true)).toContain('not_in_pool');
      expect(validateTrace(makeItems(['a', 'B'], id), c, true)).toEqual([]);
      expect(validateTrace(makeItems(['x'], id), { ...c, allow_custom: true }, true)).toEqual([]);
    });
    it('checks duplicates when repeats are off', () => {
      expect(validateTrace(makeItems(['a', 'A'], id), cfg({ allow_repeats: false }), true)).toContain('duplicate');
    });
  });

  it('suggests labels: prefix first, then substring, no exact match or duplicates', () => {
    const all = ['Check email', 'Coffee', 'Make coffee', 'coffee', 'Shower'];
    expect(suggestLabels(all, 'cof')).toEqual(['Coffee', 'Make coffee']);
    expect(suggestLabels(all, 'coffee')).toEqual(['Make coffee']);
    expect(suggestLabels(all, '')).toEqual([]);
    expect(suggestLabels(all, 'c', 2)).toHaveLength(2);
  });
});
