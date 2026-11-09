import { describe, expect, it } from 'vitest';
import type { Compare, Analytics } from '../api/types';
import { buildDiffGraph, isGroupable } from './ComparePanel';
import { effectiveAliases } from './ModerationDialog';

const an = { dfg: { nodes: [{ id: 'A', label: 'A', kind: 'activity', count: 1, case_count: 1 }], edges: [] } } as unknown as Analytics;
const cmp: Compare = {
  version: 1,
  question_id: 'q',
  group_by: { question_id: 'g', prompt: 'Role' },
  groups: [{ value: 'Students', n: 10, analytics: an }, { value: 'Lecturers', n: 8, analytics: an }],
  hidden_groups: [],
  pairwise: [],
  warnings: [],
  diff_edges: [
    { source: '__start__', target: 'A', shares: { Students: 1, Lecturers: 1 }, delta: 0, p_value: 1, q_value: 1 },
    { source: 'A', target: 'B', shares: { Students: 0.7, Lecturers: 0.2 }, delta: 0.5, p_value: 0.01, q_value: 0.02 },
    { source: 'A', target: 'C', shares: { Students: 0.1, Lecturers: 0.6 }, delta: 0.5, p_value: null, q_value: null },
  ],
};

describe('buildDiffGraph', () => {
  it('colours edges by the group with the higher share and neutral when similar', () => {
    const { graph, colors, labels } = buildDiffGraph(cmp, 0);
    expect(graph.edges).toHaveLength(3);
    expect(colors['__start__\u2192A']).toBe('#8794A2');
    expect(colors['A\u2192B']).not.toBe(colors['A\u2192C']);
    expect(labels['A\u2192B']).toBe('70%');
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C', '__start__']);
  });
  it('filters by minimum delta', () => {
    expect(buildDiffGraph(cmp, 0.3).graph.edges).toHaveLength(2);
  });
});

describe('isGroupable', () => {
  const base = { id: 'x', position: 0, prompt: 'p', help: null, required: false };
  it('accepts choices and binned numbers only', () => {
    expect(isGroupable({ ...base, type: 'single_choice', config: { options: ['a', 'b'] } })).toBe(true);
    expect(isGroupable({ ...base, type: 'number', config: { integer: true, bins: [1, 2] } })).toBe(true);
    expect(isGroupable({ ...base, type: 'number', config: { integer: true } })).toBe(false);
    expect(isGroupable({ ...base, type: 'text', config: { max_length: 5 } })).toBe(false);
    expect(isGroupable({ ...base, type: 'trace', config: {} as never })).toBe(false);
  });
});

describe('effectiveAliases', () => {
  const rows = [
    { raw_key: 'a', display: 'A', count: 3, canonical: null, hidden: false },
    { raw_key: 'b', display: 'B', count: 2, canonical: 'A', hidden: false },
    { raw_key: 'c', display: 'C', count: 1, canonical: null, hidden: false },
  ];
  it('sends only rows with an alias or hidden flag, applying local edits', () => {
    expect(effectiveAliases(rows, {})).toEqual([{ raw_key: 'b', canonical: 'A', hidden: false }]);
    expect(effectiveAliases(rows, { c: { canonical: 'A', hidden: false }, b: { canonical: null, hidden: false }, a: { canonical: null, hidden: true } })).toEqual([
      { raw_key: 'a', canonical: null, hidden: true },
      { raw_key: 'c', canonical: 'A', hidden: false },
    ]);
  });
});
