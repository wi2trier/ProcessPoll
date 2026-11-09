import { END_ID, START_ID, type Dfg, type DfgNode, type NodeKind, type Variant } from '../api/types';

export type DfgMetric = 'absolute' | 'case' | 'relative';

export interface DfgFilterOptions {

  activityPct: number;

  pathPct: number;
  metric: DfgMetric;

  dimFiltered?: boolean;
}

export interface ViewNode {
  id: string;
  label: string;
  kind: NodeKind;
  count: number;
  case_count: number;
  dimmed?: boolean;
  loopCopy?: boolean;
}
export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  case_count: number;

  value: number;

  label: string;
  selfLoop: boolean;
  dimmed?: boolean;
  reciprocal?: boolean;
  sourceEdgeId?: string;
}
export interface FilteredDfg {
  nodes: ViewNode[];
  edges: ViewEdge[];
  totalTransitions: number;
  hiddenTransitions: number;

  hiddenTransitionShare: number;
  totalActivities: number;
  hiddenActivities: number;
  maxValue: number;
}

export const DEFAULT_FILTER: DfgFilterOptions = { activityPct: 100, pathPct: 100, metric: 'absolute' };

export function edgeId(source: string, target: string): string {
  return `${source}→${target}`;
}

export function autoActivityPct(total: number, target = 18): number {
  return total > target ? Math.max(1, Math.floor((target / total) * 100)) : 100;
}

function keepCount(total: number, pct: number): number {
  if (total <= 0) return 0;
  const p = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 100;
  if (p <= 0) return 0;
  if (p >= 100) return total;
  return Math.min(total, Math.max(1, Math.ceil((total * p) / 100)));
}

export function filterDfg(dfg: Dfg | null | undefined, opts: DfgFilterOptions): FilteredDfg {
  const nodes = dfg?.nodes ?? [];
  const edges = dfg?.edges ?? [];
  const totalTransitions = edges.reduce((a, e) => a + e.count, 0);

  const nodeMap = new Map<string, DfgNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  for (const e of edges) {
    for (const id of [e.source, e.target]) {
      if (!nodeMap.has(id)) {
        const kind: NodeKind = id === START_ID ? 'start' : id === END_ID ? 'end' : 'activity';
        nodeMap.set(id, { id, label: id, kind, count: 0, case_count: 0 });
      }
    }
  }

  const activities = [...nodeMap.values()]
    .filter((n) => n.kind === 'activity')
    .sort((a, b) => b.case_count - a.case_count || b.count - a.count || a.label.localeCompare(b.label));
  const totalActivities = activities.length;
  const kept = new Set<string>(
    activities.slice(0, keepCount(totalActivities, opts.activityPct)).map((n) => n.id),
  );
  for (const n of nodeMap.values()) if (n.kind !== 'activity') kept.add(n.id);

  const outgoing = new Map<string, number>();
  for (const e of edges) outgoing.set(e.source, (outgoing.get(e.source) ?? 0) + e.count);

  const valueOf = (e: { source: string; count: number; case_count: number }): number => {
    if (opts.metric === 'case') return e.case_count;
    if (opts.metric === 'relative') {
      const out = outgoing.get(e.source) ?? 0;
      return out > 0 ? e.count / out : 0;
    }
    return e.count;
  };
  const labelOf = (value: number): string => {
    if (opts.metric === 'relative') return `${Math.round(value * 100)}%`;
    return String(value);
  };

  const candidates = edges
    .filter((e) => kept.has(e.source) && kept.has(e.target))
    .map((e) => ({ e, value: valueOf(e) }))
    .sort(
      (a, b) =>
        b.value - a.value ||
        b.e.count - a.e.count ||
        a.e.source.localeCompare(b.e.source) ||
        a.e.target.localeCompare(b.e.target),
    );
  const selected = candidates.slice(0, keepCount(candidates.length, opts.pathPct));
  const selectedIds = new Set(selected.map(({ e }) => edgeId(e.source, e.target)));

  const visibleIds = new Set<string>();
  for (const { e } of selected) {
    visibleIds.add(e.source);
    visibleIds.add(e.target);
  }
  const viewNodes: ViewNode[] = [...nodeMap.values()]
    .filter((n) => opts.dimFiltered || visibleIds.has(n.id))
    .map((n) => ({ id: n.id, label: n.label, kind: n.kind, count: n.count, case_count: n.case_count, dimmed: opts.dimFiltered && !visibleIds.has(n.id) }));
  const displayedEdges = opts.dimFiltered
    ? edges.map((e) => ({ e, value: valueOf(e) }))
    : selected;
  const viewEdges: ViewEdge[] = displayedEdges.map(({ e, value }) => ({
    id: edgeId(e.source, e.target),
    source: e.source,
    target: e.target,
    count: e.count,
    case_count: e.case_count,
    value,
    label: labelOf(value),
    selfLoop: e.source === e.target,
    dimmed: opts.dimFiltered && !selectedIds.has(edgeId(e.source, e.target)),
  }));

  const visibleTransitions = selected.reduce((a, { e }) => a + e.count, 0);
  const hiddenTransitions = Math.max(0, totalTransitions - visibleTransitions);
  const visibleActivities = activities.filter((n) => visibleIds.has(n.id)).length;

  return {
    nodes: viewNodes,
    edges: viewEdges,
    totalTransitions,
    hiddenTransitions,
    hiddenTransitionShare: totalTransitions > 0 ? hiddenTransitions / totalTransitions : 0,
    totalActivities,
    hiddenActivities: Math.max(0, totalActivities - visibleActivities),
    maxValue: viewEdges.reduce((m, e) => Math.max(m, e.value), 0),
  };
}

export function highlightTopVariants(graph: FilteredDfg, variants: Pick<Variant, 'steps'>[], topCount: number): FilteredDfg {
  const count = Number.isFinite(topCount) ? Math.max(0, Math.min(variants.length, Math.floor(topCount))) : variants.length;
  if (count >= variants.length) {
    return {
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, dimmed: false })),
      edges: graph.edges.map((e) => ({ ...e, dimmed: false })),
      hiddenTransitions: 0,
      hiddenTransitionShare: 0,
      hiddenActivities: 0,
    };
  }

  const visibleNodes = new Set<string>();
  const visibleEdges = new Set<string>();
  for (const variant of variants.slice(0, count)) {
    const path = [START_ID, ...variant.steps, END_ID];
    path.forEach((id) => visibleNodes.add(id));
    for (let i = 1; i < path.length; i++) visibleEdges.add(edgeId(path[i - 1], path[i]));
  }
  const edges = graph.edges.map((e) => ({ ...e, dimmed: !visibleEdges.has(e.id) }));
  const hiddenTransitions = edges.filter((e) => e.dimmed).reduce((sum, e) => sum + e.count, 0);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({ ...n, dimmed: !visibleNodes.has(n.id) })),
    edges,
    hiddenTransitions,
    hiddenTransitionShare: graph.totalTransitions > 0 ? hiddenTransitions / graph.totalTransitions : 0,
    hiddenActivities: graph.nodes.filter((n) => n.kind === 'activity' && !visibleNodes.has(n.id)).length,
  };
}

export function expandSelfLoops(g: Pick<FilteredDfg, 'nodes' | 'edges'>): Pick<FilteredDfg, 'nodes' | 'edges'> {
  const nodes = [...g.nodes];
  const edges: ViewEdge[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of g.edges) {
    if (!edge.selfLoop) {
      edges.push(edge);
      continue;
    }
    const original = byId.get(edge.source);
    if (!original) {
      edges.push(edge);
      continue;
    }
    const copyId = `${edge.id}::loop-copy`;
    nodes.push({ ...original, id: copyId, loopCopy: true, dimmed: edge.dimmed || original.dimmed });
    edges.push(
      { ...edge, id: `${edge.id}::loop-out`, target: copyId, selfLoop: false, reciprocal: true, sourceEdgeId: edge.id },
      { ...edge, id: `${edge.id}::loop-back`, source: copyId, label: '', selfLoop: false, reciprocal: true, sourceEdgeId: edge.id },
    );
  }
  return { nodes, edges };
}

export function topologyKey(g: Pick<FilteredDfg, 'nodes' | 'edges'>): string {
  const n = g.nodes.map((x) => x.id).sort().join('\u0001');
  const e = g.edges.map((x) => x.id).sort().join('\u0001');
  return `${n}\u0002${e}`;
}
