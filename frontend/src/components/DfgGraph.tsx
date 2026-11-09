import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { displayName } from '../lib/labels';
import { activityTone, INK } from '../lib/colors';
import { expandSelfLoops, topologyKey, type FilteredDfg } from '../lib/dfgFilter';
import { Icon } from './Icon';
import { IconTip, Tooltip } from './Tooltip';

let registered = false;
function ensureRegistered() {
  if (registered) return;
  cytoscape.use(dagre);
  registered = true;
}

export interface DfgGraphProps {
  graph: FilteredDfg;

  edgeColors?: Record<string, string>;

  edgeLabels?: Record<string, string>;

  height?: number | string;
  mini?: boolean;

  showControls?: boolean;
  ariaLabel?: string;
  testId?: string;

  large?: boolean;

  onToggleFullscreen?: () => void;
  fullscreen?: boolean;

  bare?: boolean;

  topLeft?: ReactNode;
  bottomLeft?: ReactNode;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const REL_DASH = 0.25;
const EDGE = '#91A7AD';
const FONT = 'Figtree Variable, system-ui, sans-serif';

function buildStyle(mini: boolean, large: boolean, bare: boolean): cytoscape.StylesheetJson {
  const fs = large ? 18 : bare ? 16 : mini ? 10 : 14;
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        shape: 'round-rectangle',
        'background-color': 'data(bg)',
        'border-color': 'data(border)',
        'border-width': mini ? 2 : 2.5,
        color: 'data(fg)',
        'font-family': FONT,
        'font-size': fs,
        'font-weight': 600,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'ellipsis',
        'text-max-width': large ? '200px' : mini ? '60px' : '130px',
        width: 'label',
        height: 'label',
        padding: mini ? '4px' : large ? '12px' : '8px',
      },
    },
    {
      selector: 'node[kind = "start"], node[kind = "end"]',
      style: { shape: 'round-rectangle', 'font-size': fs - 1, padding: mini ? '4px' : '8px' },
    },
    {
      selector: 'edge',
      style: {
        width: 'data(w)',
        'line-color': 'data(color)',
        'target-arrow-color': 'data(color)',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': mini ? 0.7 : 1,
        'line-style': 'solid',
        label: mini ? '' : 'data(label)',
        'font-size': large ? 15 : bare ? 13 : mini ? 10 : 12,
        color: '#62798A',
        'font-family': FONT,
        'font-weight': 700,
        'text-background-color': '#F7FAFA',
        'text-background-opacity': mini ? 0 : 0.96,
        'text-background-padding': mini ? '0px' : '3px',
        'text-background-shape': 'roundrectangle',
        'text-border-color': '#D9E2E4',
        'text-border-width': mini ? 0 : 1,
        'text-border-opacity': mini ? 0 : 1,
        'text-margin-x': mini ? 0 : 14,
        'text-margin-y': mini ? 0 : -14,
        'text-rotation': 'none',
      },
    },
    {
      selector: 'edge[?reciprocal]',
      style: { 'curve-style': 'unbundled-bezier', 'control-point-distances': 32, 'control-point-weights': 0.5 },
    },
    { selector: 'edge[?dashed]', style: { 'line-style': 'dashed' } },
    { selector: 'node[?dimmed], edge[?dimmed]', style: { opacity: 0.16 } },
    { selector: 'node:selected', style: { 'border-width': 4 } },
    { selector: 'edge:selected', style: { width: 5 } },
    { selector: '.dim', style: { opacity: 0.18 } },
  ];
}

function nodeVisual(n: FilteredDfg['nodes'][number], t: (k: string) => string) {
  if (n.kind === 'start') return { label: t('dfg.start'), bg: '#E2F3EF', border: '#087C73', fg: INK };
  if (n.kind === 'end') return { label: t('dfg.end'), bg: '#FDF2E0', border: '#D97908', fg: INK };
  const tone = activityTone(n.label);
  return { label: displayName(n.label, '', ''), bg: tone.bg, border: tone.icon, fg: INK };
}

export function DfgGraph({
  graph,
  edgeColors,
  edgeLabels,
  height = 420,
  mini = false,
  showControls = true,
  ariaLabel,
  testId = 'dfg-canvas',
  large = false,
  onToggleFullscreen,
  fullscreen = false,
  bare = false,
  topLeft,
  bottomLeft,
}: DfgGraphProps) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const lastTopo = useRef<string>('');
  const interacted = useRef(false);
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    ensureRegistered();
    const el = containerRef.current;
    if (!el) return;
    let cy: Core;
    try {
      cy = cytoscape({
        container: el,
        elements: [],
        style: buildStyle(mini, large, bare),
        minZoom: 0.2,
        maxZoom: 3,
        wheelSensitivity: 0.25,
        userZoomingEnabled: !mini,
        userPanningEnabled: !mini,
        boxSelectionEnabled: false,
        autoungrabify: false,
      });
    } catch {
      return;
    }
    cyRef.current = cy;
    lastTopo.current = '';
    const markInteracted = () => {
      interacted.current = true;
    };
    cy.on('zoom', () => setZoom(Math.round(cy.zoom() * 100)));
    cy.on('dragpan', markInteracted);
    cy.on('scrollzoom', markInteracted);
    cy.on('mouseover', 'node', (e) => {
      const nb = e.target.closedNeighborhood();
      cy.elements().not(nb).addClass('dim');
    });
    cy.on('mouseout', 'node', () => cy.elements().removeClass('dim'));

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      cy.resize();
      if (!interacted.current) cy.fit(undefined, bare ? 88 : 24);
    }) : null;
    ro?.observe(el);
    return () => {
      if (layoutTimer.current) clearTimeout(layoutTimer.current);
      ro?.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [mini, large, bare]);

  const visualGraph = useMemo(() => expandSelfLoops(graph), [graph]);
  const topo = useMemo(() => topologyKey(visualGraph), [visualGraph]);
  const maxValue = graph.maxValue || 1;

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const tt = tRef.current;
    const wanted = new Set<string>();

    cy.batch(() => {
      for (const n of visualGraph.nodes) {
        wanted.add(n.id);
        const v = nodeVisual(n, tt);
        const existing = cy.getElementById(n.id);
        const data = { id: n.id, kind: n.kind, count: n.count, dimmed: n.dimmed, ...v };
        if (existing.nonempty()) existing.data(data);
        else {

          const nbrs = visualGraph.edges
            .filter((e) => e.source === n.id || e.target === n.id)
            .map((e) => cy.getElementById(e.source === n.id ? e.target : e.source))
            .filter((x) => x.nonempty() && x.isNode());
          let pos = { x: cy.width() / 2, y: cy.height() / 2 };
          if (nbrs.length) {
            pos = {
              x: nbrs.reduce((a, x) => a + x.position('x'), 0) / nbrs.length,
              y: nbrs.reduce((a, x) => a + x.position('y'), 0) / nbrs.length,
            };
          }
          const def: ElementDefinition = { group: 'nodes', data, position: pos };
          cy.add(def);
        }
      }
      for (const e of visualGraph.edges) {
        wanted.add(e.id);
        const rel = e.value / maxValue;
        const data = {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label ? edgeLabels?.[e.sourceEdgeId ?? e.id] ?? e.label : '',
          w: mini ? 1 + 3 * rel : 1.5 + 5 * rel,
          dashed: rel < REL_DASH,
          dimmed: e.dimmed,
          reciprocal: e.reciprocal,
          color: edgeColors?.[e.sourceEdgeId ?? e.id] ?? EDGE,
        };
        const existing = cy.getElementById(e.id);
        if (existing.nonempty()) existing.data(data);
        else cy.add({ group: 'edges', data });
      }
      cy.elements().forEach((el) => {
        if (!wanted.has(el.id())) cy.remove(el);
      });
    });

    if (topo !== lastTopo.current) {
      const first = lastTopo.current === '';
      lastTopo.current = topo;
      const run = () => {
        const c2 = cyRef.current;
        if (!c2 || c2.elements().empty()) return;
        const animate = !first && !prefersReducedMotion();
        c2.layout({
          name: 'dagre',

          rankDir: c2.width() > c2.height() * 1.4 ? 'LR' : 'TB',
          nodeSep: mini ? 14 : 70,
          rankSep: mini ? 26 : 100,
          edgeSep: mini ? 10 : 36,
          animate,
          animationDuration: 300,
          fit: !interacted.current,
          padding: bare ? 88 : 24,
        } as cytoscape.LayoutOptions).run();
      };
      if (layoutTimer.current) clearTimeout(layoutTimer.current);
      if (first) run();
      else layoutTimer.current = setTimeout(run, 350);
    }
  }, [visualGraph, topo, maxValue, edgeColors, edgeLabels, mini, bare]);

  const zoomBy = (f: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    interacted.current = true;
    cy.zoom({ level: Math.min(3, Math.max(0.2, cy.zoom() * f)), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const fit = () => {
    const cy = cyRef.current;
    if (!cy) return;
    interacted.current = false;
    cy.fit(undefined, bare ? 88 : 24);
  };

  const topEdges = [...graph.edges].sort((a, b) => b.value - a.value).slice(0, 12);
  const nodeLabel = (id: string) => displayName(graph.nodes.find((n) => n.id === id)?.label ?? id, t('dfg.start'), t('dfg.end'));
  const floating = 'rounded-xl border border-line bg-white/95 shadow-[0_2px_10px_rgba(22,45,51,0.08)]';

  return (
    <div className={`relative ${typeof height === 'string' ? 'h-full' : ''}`}>
      <div
        ref={containerRef}
        data-testid={testId}
        role="img"
        aria-label={ariaLabel ?? t('dfg.ariaLabel', { nodes: graph.nodes.length, edges: graph.edges.length })}
        className={`w-full overflow-hidden bg-white ${bare ? '' : 'rounded-2xl border border-line'}`}
        style={{ height }}
      />
      <ul className="sr-only" aria-label={t('dfg.topTransitions')}>
        {topEdges.map((e) => (
          <li key={e.id}>{nodeLabel(e.source)} → {nodeLabel(e.target)}: {e.label}</li>
        ))}
      </ul>
      {topLeft && <div className="absolute left-3 top-3 z-10 max-w-[calc(100%-9rem)] sm:left-4 sm:top-4">{topLeft}</div>}
      {onToggleFullscreen && !mini && (
        <Tooltip content={fullscreen ? t('dfg.exitFullscreen') : t('tips.dfg.fullscreen')} placement="bottom" describe={!fullscreen}>
          <button
            type="button"
            onClick={onToggleFullscreen}
            className={`${floating} absolute right-3 top-3 z-10 inline-flex min-h-[40px] items-center gap-2 px-3 text-sm font-semibold text-ink hover:border-ink sm:right-4 sm:top-4`}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? t('dfg.exitFullscreen') : t('dfg.fullscreenLabel')}
            data-testid="dfg-fullscreen"
          >
            <Icon name={fullscreen ? 'exitfullscreen' : 'fullscreen'} size={16} />
            <span className={fullscreen ? 'sr-only sm:not-sr-only' : 'sr-only sm:not-sr-only'}>
              {fullscreen ? t('dfg.exitFullscreen') : t('dfg.fullscreen')}
            </span>
          </button>
        </Tooltip>
      )}
      {bottomLeft && <div className="absolute bottom-3 left-3 z-10 max-w-[calc(100%-13rem)] sm:bottom-4 sm:left-4">{bottomLeft}</div>}
      {showControls && !mini && (
        <div className={`${floating} absolute bottom-3 right-3 z-10 flex items-center gap-0.5 p-1 text-ink sm:bottom-4 sm:right-4`} data-testid="dfg-zoom">
          <IconTip label={t('dfg.zoomOut')}>
            <button type="button" className="btn-icon !h-9 !w-9" onClick={() => zoomBy(1 / 1.25)} aria-label={t('dfg.zoomOut')}>
              <Icon name="minus" size={14} />
            </button>
          </IconTip>
          <span className="min-w-[3rem] text-center text-sm font-semibold tabular-nums" aria-live="off">{zoom}%</span>
          <IconTip label={t('dfg.zoomIn')}>
            <button type="button" className="btn-icon !h-9 !w-9" onClick={() => zoomBy(1.25)} aria-label={t('dfg.zoomIn')}>
              <Icon name="plus" size={14} />
            </button>
          </IconTip>
          <IconTip label={t('dfg.fit')}>
            <button type="button" className="btn-icon !h-9 !w-9" onClick={fit} aria-label={t('dfg.fit')}>
              <Icon name="fit" size={14} />
            </button>
          </IconTip>
        </div>
      )}
    </div>
  );
}
