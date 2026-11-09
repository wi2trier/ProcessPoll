import { describe, expect, it } from 'vitest';
import type { Dfg } from '../api/types';
import { autoActivityPct, DEFAULT_FILTER, expandSelfLoops, filterDfg, highlightTopVariants, topologyKey } from './dfgFilter';

const dfg: Dfg = {
  nodes: [
    { id: '__start__', label: 'START', kind: 'start', count: 10, case_count: 10 },
    { id: '__end__', label: 'END', kind: 'end', count: 10, case_count: 10 },
    { id: 'Wake up', label: 'Wake up', kind: 'activity', count: 10, case_count: 10 },
    { id: 'Bathroom', label: 'Bathroom', kind: 'activity', count: 10, case_count: 10 },
    { id: 'Coffee', label: 'Coffee', kind: 'activity', count: 6, case_count: 6 },
    { id: 'Shower', label: 'Shower', kind: 'activity', count: 4, case_count: 4 },
  ],
  edges: [
    { source: '__start__', target: 'Wake up', count: 10, case_count: 10 },
    { source: 'Wake up', target: 'Bathroom', count: 10, case_count: 10 },
    { source: 'Bathroom', target: 'Coffee', count: 6, case_count: 6 },
    { source: 'Bathroom', target: 'Shower', count: 4, case_count: 4 },
    { source: 'Coffee', target: '__end__', count: 6, case_count: 6 },
    { source: 'Shower', target: '__end__', count: 4, case_count: 4 },
    { source: 'Coffee', target: 'Coffee', count: 2, case_count: 2 },
  ],
};
const total = 10 + 10 + 6 + 4 + 6 + 4 + 2;

describe('filterDfg', () => {
  it('keeps everything at 100 %/100 %', () => {
    const g = filterDfg(dfg, DEFAULT_FILTER);
    expect(g.nodes).toHaveLength(6);
    expect(g.edges).toHaveLength(7);
    expect(g.totalTransitions).toBe(total);
    expect(g.hiddenTransitions).toBe(0);
    expect(g.hiddenTransitionShare).toBe(0);
    expect(g.hiddenActivities).toBe(0);
  });

  it('keeps self-loops', () => {
    const g = filterDfg(dfg, DEFAULT_FILTER);
    const loop = g.edges.find((e) => e.selfLoop);
    expect(loop?.source).toBe('Coffee');
  });

  it('activity slider keeps the most frequent activities and always start/end', () => {

    const g = filterDfg(dfg, { ...DEFAULT_FILTER, activityPct: 50 });
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['Bathroom', 'Wake up', '__start__']);

    expect(g.edges.map((e) => e.id).sort()).toEqual(['Wake up\u2192Bathroom', '__start__\u2192Wake up'].sort());
    expect(g.hiddenActivities).toBe(2);
    expect(g.hiddenTransitionShare).toBeCloseTo((total - 20) / total, 6);
  });

  it('always keeps at least one activity', () => {
    const g = filterDfg(dfg, { ...DEFAULT_FILTER, activityPct: 1 });
    expect(g.nodes.filter((n) => n.kind === 'activity').length).toBeLessThanOrEqual(1);
  });

  it('dims instead of removing filtered elements when requested', () => {
    const g = filterDfg(dfg, { ...DEFAULT_FILTER, activityPct: 50, pathPct: 30, dimFiltered: true });
    expect(g.nodes).toHaveLength(dfg.nodes.length);
    expect(g.edges).toHaveLength(dfg.edges.length);
    expect(g.nodes.some((n) => n.dimmed)).toBe(true);
    expect(g.edges.some((e) => e.dimmed)).toBe(true);
    expect(g.hiddenActivities).toBeGreaterThan(0);
  });

  it('dims the complete model at zero percent', () => {
    const g = filterDfg(dfg, { ...DEFAULT_FILTER, activityPct: 0, pathPct: 0, dimFiltered: true });
    expect(g.nodes.every((n) => n.dimmed)).toBe(true);
    expect(g.edges.every((e) => e.dimmed)).toBe(true);
  });

  it('path slider keeps the strongest edges', () => {
    const g = filterDfg(dfg, { ...DEFAULT_FILTER, pathPct: 30 });
    expect(g.edges).toHaveLength(3);
    expect(g.edges.every((e) => e.count >= 6)).toBe(true);
    expect(g.hiddenTransitions).toBe(total - g.edges.reduce((a, e) => a + e.count, 0));
    expect(g.hiddenTransitionShare).toBeGreaterThan(0);

    expect(g.nodes.map((n) => n.id)).not.toContain('Shower');
  });

  it('is deterministic and does not mutate its input', () => {
    const copy = JSON.stringify(dfg);
    const a = filterDfg(dfg, { ...DEFAULT_FILTER, pathPct: 50 });
    const b = filterDfg(dfg, { ...DEFAULT_FILTER, pathPct: 50 });
    expect(a).toEqual(b);
    expect(JSON.stringify(dfg)).toBe(copy);
  });

  it('computes metric labels', () => {
    const abs = filterDfg(dfg, { ...DEFAULT_FILTER, metric: 'absolute' });
    expect(abs.edges.find((e) => e.id === 'Bathroom\u2192Coffee')?.label).toBe('6');
    const rel = filterDfg(dfg, { ...DEFAULT_FILTER, metric: 'relative' });
    expect(rel.edges.find((e) => e.id === 'Bathroom\u2192Coffee')?.label).toBe('60%');
    expect(rel.edges.find((e) => e.id === 'Wake up\u2192Bathroom')?.label).toBe('100%');
    const cs = filterDfg(dfg, { ...DEFAULT_FILTER, metric: 'case' });
    expect(cs.edges.find((e) => e.id === 'Coffee\u2192Coffee')?.value).toBe(2);
  });

  it('handles empty and missing input', () => {
    for (const input of [null, undefined, { nodes: [], edges: [] }]) {
      const g = filterDfg(input, DEFAULT_FILTER);
      expect(g.nodes).toEqual([]);
      expect(g.edges).toEqual([]);
      expect(g.hiddenTransitionShare).toBe(0);
    }
  });

  it('adds virtual nodes that edges reference but nodes omit', () => {
    const g = filterDfg({ nodes: [], edges: [{ source: '__start__', target: 'A', count: 1, case_count: 1 }] }, DEFAULT_FILTER);
    expect(g.nodes.map((n) => n.kind).sort()).toEqual(['activity', 'start']);
  });

  it('survives out-of-range slider values', () => {
    expect(filterDfg(dfg, { ...DEFAULT_FILTER, activityPct: 1000, pathPct: -5 }).edges).toHaveLength(0);
    expect(filterDfg(dfg, { ...DEFAULT_FILTER, activityPct: NaN }).nodes).toHaveLength(6);
  });
});

describe('expandSelfLoops', () => {
  it('renders a loop as two equally named nodes with reciprocal arrows', () => {
    const filtered = filterDfg(dfg, DEFAULT_FILTER);
    const expanded = expandSelfLoops(filtered);
    const coffeeNodes = expanded.nodes.filter((n) => n.label === 'Coffee');
    const reciprocal = expanded.edges.filter((e) => e.reciprocal);
    expect(coffeeNodes).toHaveLength(2);
    expect(reciprocal).toHaveLength(2);
    expect(reciprocal.map((e) => `${e.source}→${e.target}`)).toEqual([
      `Coffee→Coffee→Coffee::loop-copy`,
      `Coffee→Coffee::loop-copy→Coffee`,
    ]);
    expect(reciprocal.filter((e) => e.label)).toHaveLength(1);
  });
});

describe('highlightTopVariants', () => {
  const variants = [
    { steps: ['Wake up', 'Bathroom', 'Coffee'] },
    { steps: ['Wake up', 'Bathroom', 'Shower'] },
  ];

  it('keeps each selected variant complete from start to end', () => {
    const graph = highlightTopVariants(filterDfg(dfg, DEFAULT_FILTER), variants, 1);
    const prominent = graph.edges.filter((e) => !e.dimmed).map((e) => e.id);
    expect(prominent).toEqual([
      '__start__→Wake up',
      'Wake up→Bathroom',
      'Bathroom→Coffee',
      'Coffee→__end__',
    ]);
    expect(graph.nodes.find((n) => n.id === 'Shower')?.dimmed).toBe(true);
  });

  it('shows the complete graph when all variants are selected', () => {
    const graph = highlightTopVariants(filterDfg(dfg, DEFAULT_FILTER), variants, variants.length);
    expect(graph.nodes.every((n) => !n.dimmed)).toBe(true);
    expect(graph.edges.every((e) => !e.dimmed)).toBe(true);
  });
});

describe('autoActivityPct', () => {
  it('shows everything for small graphs and the top ~18 for large ones', () => {
    expect(autoActivityPct(10)).toBe(100);
    expect(autoActivityPct(18)).toBe(100);
    expect(autoActivityPct(90)).toBe(20);
    expect(autoActivityPct(1000)).toBe(1);
    expect(autoActivityPct(0)).toBe(100);
  });
});

describe('topologyKey', () => {
  it('only changes with node/edge sets, not with counts', () => {
    const a = filterDfg(dfg, DEFAULT_FILTER);
    const bumped: Dfg = { ...dfg, edges: dfg.edges.map((e) => ({ ...e, count: e.count + 5 })) };
    expect(topologyKey(filterDfg(bumped, DEFAULT_FILTER))).toBe(topologyKey(a));
    expect(topologyKey(filterDfg(dfg, { ...DEFAULT_FILTER, pathPct: 30 }))).not.toBe(topologyKey(a));
  });
});
