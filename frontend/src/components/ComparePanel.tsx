import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCompare } from '../api/hooks';
import type { Auth } from '../api/client';
import { END_ID, START_ID, type Compare, type DfgNode, type NumberConfig, type Question } from '../api/types';
import { groupColor } from '../lib/colors';
import { autoActivityPct, edgeId, filterDfg, type FilteredDfg, type ViewEdge, type ViewNode } from '../lib/dfgFilter';
import { groupByName, presentationName } from '../lib/presentation';
import { formatNumber, formatPercent } from '../lib/stats';
import { FieldLabel, InfoTip } from './Tooltip';
import { Banner, ErrorBox, Spinner, Tabs } from './ui';
import { DfgGraph } from './DfgGraph';
import { EmptyState, useNodeName } from './AnalyticsPanels';

export function isGroupable(q: Question): boolean {
  if (q.type === 'single_choice' || q.type === 'multiple_choice') return true;
  if (q.type === 'number') {
    const bins = (q.config as Partial<NumberConfig>).bins;
    return Array.isArray(bins) && bins.length > 0;
  }
  return false;
}

const NEUTRAL = '#8794A2';
const DELTA_NEUTRAL = 0.05;

export function buildDiffGraph(
  cmp: Compare,
  minDelta: number,
): { graph: FilteredDfg; colors: Record<string, string>; labels: Record<string, string> } {
  const nodeMap = new Map<string, DfgNode>();
  for (const g of cmp.groups) for (const n of g.analytics.dfg?.nodes ?? []) if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
  const order = cmp.groups.map((g) => g.value);
  const colors: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const edges: ViewEdge[] = [];
  const used = new Set<string>();
  for (const e of cmp.diff_edges) {
    if (e.delta < minDelta) continue;
    const entries = Object.entries(e.shares);
    if (entries.length === 0) continue;
    const [bestGroup, bestShare] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    const id = edgeId(e.source, e.target);
    colors[id] = e.delta < DELTA_NEUTRAL ? NEUTRAL : groupColor(Math.max(0, order.indexOf(bestGroup)));
    labels[id] = `${Math.round(bestShare * 100)}%`;
    edges.push({ id, source: e.source, target: e.target, count: 0, case_count: 0, value: bestShare, label: labels[id], selfLoop: e.source === e.target });
    used.add(e.source);
    used.add(e.target);
  }
  const nodes: ViewNode[] = [...used].map((id) => {
    const n = nodeMap.get(id);
    const kind = n?.kind ?? (id === START_ID ? 'start' : id === END_ID ? 'end' : 'activity');
    return { id, label: n?.label ?? id, kind, count: n?.count ?? 0, case_count: n?.case_count ?? 0 };
  });
  return {
    graph: {
      nodes,
      edges,
      totalTransitions: 0,
      hiddenTransitions: 0,
      hiddenTransitionShare: 0,
      totalActivities: nodes.length,
      hiddenActivities: 0,
      maxValue: edges.reduce((m, e) => Math.max(m, e.value), 0),
    },
    colors,
    labels,
  };
}

function formatQ(v: number | null): string {
  if (v == null) return '–';
  if (v < 0.001) return '<0.001';
  return v.toFixed(3);
}

export function ComparePanel({
  code,
  auth,
  questions,
  traceQuestionId,
  kMin,
}: {
  code: string;
  auth: Auth | null;
  questions: Question[];
  traceQuestionId: string | undefined;
  kMin?: number;
}) {
  const { t } = useTranslation();
  const uid = useId();
  const name = useNodeName();
  const groupable = useMemo(() => questions.filter(isGroupable), [questions]);
  const [groupBy, setGroupBy] = useState<string>('');
  const [view, setView] = useState<'side' | 'diff'>('side');
  const [pathPct, setPathPct] = useState(100);
  const [minDelta, setMinDelta] = useState(0);

  const effective = groupBy && groupable.some((q) => q.id === groupBy) ? groupBy : groupable[0]?.id;
  const cmp = useCompare(code, auth, traceQuestionId, effective, groupable.length > 0);
  const data = cmp.data;

  const diff = useMemo(() => (data ? buildDiffGraph(data, minDelta) : null), [data, minDelta]);

  if (groupable.length === 0) {
    return (
      <div data-testid="compare-panel">
        <EmptyState title={t('compare.noGroupable')} text={t('compare.noGroupableText')} />
      </div>
    );
  }

  const topDiff = data ? [...data.diff_edges].sort((a, b) => b.delta - a.delta).slice(0, 6) : [];
  const k = kMin ?? 5;

  return (
    <div data-testid="compare-panel" className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-0.5">
          <label htmlFor={`${uid}-by`} className="font-semibold">{t('compare.by')}</label>
          <InfoTip text={t('tips.compare.groupBy')} />
        </span>
        <select id={`${uid}-by`} className="input input-sm !w-auto max-w-full" value={effective} onChange={(e) => setGroupBy(e.target.value)} data-testid="compare-groupby">
          {groupable.map((q) => (
            <option key={q.id} value={q.id}>{presentationName(q)}</option>
          ))}
        </select>
        <div className="sm:ml-auto">
          <Tabs
            label={t('compare.view')}
            value={view}
            onChange={setView}
            tabs={[
              { id: 'side', label: t('compare.sideBySide'), tip: t('tips.compare.view') },
              { id: 'diff', label: t('compare.difference'), tip: t('tips.compare.view') },
            ]}
          />
        </div>
      </div>
      {data?.group_by && <p className="text-ink-soft" data-testid="compare-group-by">{t('compare.groupedBy', { name: groupByName(data.group_by) })}</p>}

      {cmp.isPending && cmp.fetchStatus !== 'idle' ? (
        <Spinner />
      ) : cmp.isError && !data ? (
        <ErrorBox error={cmp.error} onRetry={() => void cmp.refetch()} />
      ) : !data ? (
        <EmptyState title={t('empty.noResponses')} />
      ) : (
        <>
          {data.warnings.map((w) => (
            <Banner key={w} tone="warn" live>{t(`compare.warning.${w}`, { defaultValue: w, k })}</Banner>
          ))}
          {data.hidden_groups.length > 0 && (
            <Banner tone="info">
              <div className="flex items-start gap-0.5">
                <p className="min-w-0 flex-1">
                  {t('compare.hiddenGroups', { count: data.hidden_groups.length, k })}{' '}
                  <span className="text-ink-soft">{data.hidden_groups.map((g) => `${g.value} (n=${g.n})`).join(', ')}</span>
                </p>
                <InfoTip text={t('tips.compare.hiddenGroups')} />
              </div>
            </Banner>
          )}

          {data.groups.length === 0 ? (
            <EmptyState title={t('compare.noGroups')} text={t('compare.noGroupsText', { k })} />
          ) : view === 'side' ? (
            <>
              <div className="max-w-xs">
                <FieldLabel htmlFor={`${uid}-pp`} tip={t('tips.dfg.paths')} hint={<span className="ml-auto text-sm font-semibold tabular-nums text-ink-soft" aria-hidden="true">{pathPct}%</span>} className="!mb-0">{t('dfg.paths')}</FieldLabel>
                <input id={`${uid}-pp`} type="range" min={1} max={100} value={pathPct} onChange={(e) => setPathPct(Number(e.target.value))} className="h-8 w-full" />
              </div>
              <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3" data-testid="compare-groups">
                {data.groups.map((g, i) => {
                  const nAct = (g.analytics.dfg?.nodes ?? []).filter((n) => n.kind === 'activity').length;
                  const fg = filterDfg(g.analytics.dfg, { metric: 'case', activityPct: autoActivityPct(nAct, 12), pathPct });
                  return (
                    <div key={g.value}>
                      <h3 className="mb-2 flex items-center gap-2 font-display text-lg font-bold">
                        <span className="inline-block h-3.5 w-3.5 rounded-[3px]" style={{ backgroundColor: groupColor(i) }} aria-hidden="true" />
                        {g.value} <span className="font-medium text-ink-soft">n={g.n}</span>
                      </h3>
                      <DfgGraph graph={fg} mini height={300} showControls={false} testId="dfg-mini" ariaLabel={t('compare.groupGraph', { group: g.value, n: g.n })} />
                      <p className="mt-2 text-sm text-ink-soft">
                        {t('compare.groupStats', { variants: g.analytics.kpis.n_variants, top: formatPercent(g.analytics.kpis.top_variant_share) })}
                      </p>
                    </div>
                  );
                })}
              </div>
            </>
          ) : diff ? (
            <>
              <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                <ul className="flex flex-wrap gap-x-5 gap-y-2" aria-label={t('compare.legend')}>
                  {data.groups.map((g, i) => (
                    <li key={g.value} className="flex items-center gap-2 font-semibold">
                      <span className="inline-block h-2 w-7 rounded-sm" style={{ backgroundColor: groupColor(i) }} aria-hidden="true" />
                      {t('compare.higherIn', { group: g.value })}
                    </li>
                  ))}
                  <li className="flex items-center gap-2 text-ink-soft">
                    <span className="inline-block h-2 w-7 rounded-sm" style={{ backgroundColor: NEUTRAL }} aria-hidden="true" />
                    {t('compare.similar')}
                  </li>
                </ul>
                <div className="w-52">
                  <FieldLabel htmlFor={`${uid}-md`} tip={t('tips.compare.minDelta')} hint={<span className="ml-auto text-sm font-semibold tabular-nums text-ink-soft" aria-hidden="true">{Math.round(minDelta * 100)}pp</span>} className="!mb-0">{t('compare.minDelta')}</FieldLabel>
                  <input id={`${uid}-md`} type="range" min={0} max={50} value={Math.round(minDelta * 100)} onChange={(e) => setMinDelta(Number(e.target.value) / 100)} className="h-8 w-full" />
                </div>
              </div>
              {diff.graph.edges.length === 0 ? (
                <EmptyState title={t('compare.noDiffEdges')} />
              ) : (
                <DfgGraph graph={diff.graph} edgeColors={diff.colors} edgeLabels={diff.labels} height={460} testId="dfg-diff" ariaLabel={t('compare.diffGraph')} />
              )}
              {topDiff.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <caption className="mb-2 text-left font-display text-lg font-bold">
                      <span className="inline-flex items-center gap-0.5">{t('compare.topDiffs')} <span className="text-base font-medium text-ink-soft">({t('compare.exploratory')})</span><InfoTip text={t('tips.compare.stats')} /></span>
                    </caption>
                    <thead className="text-sm text-ink-soft">
                      <tr>
                        <th className="py-2 pr-4 font-semibold">{t('compare.colTransition')}</th>
                        <th className="py-2 pr-4 font-semibold">{t('compare.colShares')}</th>
                        <th className="py-2 pr-4 font-semibold">Δ</th>
                        <th className="py-2 pr-4 font-semibold">p</th>
                        <th className="py-2 font-semibold">q</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topDiff.map((e) => (
                        <tr key={edgeId(e.source, e.target)} className="border-t border-line">
                          <td className="py-2 pr-4">{name(e.source)} → {name(e.target)}</td>
                          <td className="py-2 pr-4">{Object.entries(e.shares).map(([g, s]) => `${g} ${formatPercent(s)}`).join(' · ')}</td>
                          <td className="py-2 pr-4 tabular-nums">{Math.round(e.delta * 100)}pp</td>
                          <td className="py-2 pr-4 tabular-nums">{formatQ(e.p_value)}</td>
                          <td className="py-2 tabular-nums">{formatQ(e.q_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}

          {data.pairwise.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <caption className="mb-2 text-left font-display text-lg font-bold">
                  <span className="inline-flex items-center gap-0.5">{t('compare.pairwise')}<InfoTip text={t('tips.compare.pairwise')} /></span>
                </caption>
                <thead className="text-sm text-ink-soft">
                  <tr>
                    <th className="py-2 pr-4 font-semibold">{t('compare.colPair')}</th>
                    <th className="py-2 pr-4 font-semibold">{t('compare.edges')}</th>
                    <th className="py-2 font-semibold">{t('compare.variants')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pairwise.map((p) => (
                    <tr key={`${p.a}|${p.b}`} className="border-t border-line">
                      <td className="py-2 pr-4">{p.a} ↔ {p.b}</td>
                      <td className="py-2 pr-4 tabular-nums">{formatNumber(p.js_edges, 2)}</td>
                      <td className="py-2 tabular-nums">{formatNumber(p.js_variants, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
