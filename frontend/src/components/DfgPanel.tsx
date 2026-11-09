import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Analytics } from '../api/types';
import { filterDfg, highlightTopVariants, type DfgMetric } from '../lib/dfgFilter';
import { useFullscreen } from '../lib/useFullscreen';
import { DfgGraph } from './DfgGraph';
import { EmptyState } from './AnalyticsPanels';
import { Icon } from './Icon';
import { FieldLabel, InfoTip } from './Tooltip';

interface FilterState {
  metric: DfgMetric;
  topVariants: number;
  totalVariants: number;
  setMetric: (m: DfgMetric) => void;
  setTopVariants: (n: number) => void;
}

function FilterControls({ f, compact = false }: { f: FilterState; compact?: boolean }) {
  const { t } = useTranslation();
  const uid = useId();
  const all = f.topVariants >= f.totalVariants;
  const valueText = all ? t('dfg.allVariants', { count: f.totalVariants }) : t('dfg.topVariantCount', { count: f.topVariants });
  return (
    <div className={compact ? 'grid items-end gap-3 sm:grid-cols-[minmax(10rem,16rem)_minmax(6.5rem,8.5rem)]' : 'grid items-end gap-4 sm:grid-cols-[1fr_auto]'}>
      <div>
        <FieldLabel htmlFor={`${uid}-variants`} tip={t('tips.dfg.topVariants')} hint={<span className="ml-auto text-sm font-semibold tabular-nums text-ink-soft" aria-hidden="true">{valueText}</span>} className="!mb-0">
          {t('dfg.topVariants')}
        </FieldLabel>
        <input id={`${uid}-variants`} type="range" min={1} max={Math.max(1, f.totalVariants)} value={Math.max(1, f.topVariants)} onChange={(e) => f.setTopVariants(Number(e.target.value))} className="h-7 w-full" aria-valuetext={valueText} data-testid="dfg-variants" />
      </div>
      <div>
        <FieldLabel htmlFor={`${uid}-metric`} tip={t('tips.dfg.metric')} className="!mb-0">{t('dfg.metric')}</FieldLabel>
        <select id={`${uid}-metric`} className={`input input-sm ${compact ? '' : '!w-auto'}`} value={f.metric} onChange={(e) => f.setMetric(e.target.value as DfgMetric)} data-testid="dfg-metric">
          <option value="absolute">{t('dfg.metricAbsolute')}</option>
          <option value="relative">{t('dfg.metricRelative')}</option>
        </select>
      </div>
    </div>
  );
}

function FloatingFilters({ f }: { f: FilterState }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 640);
  const panelId = useId();
  return (
    <div className="card flex w-fit max-w-[calc(100vw-9rem)] flex-wrap items-center gap-x-4 gap-y-1 bg-white/95 p-1.5 pr-3" data-testid="dfg-filters" data-open={open}>
      <button type="button" className="flex min-h-[40px] items-center gap-2 rounded-lg px-2.5 text-sm font-semibold hover:bg-line" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)} data-testid="dfg-filters-toggle">
        <Icon name="filter" size={16} />
        {t('dfg.filters')}
        <Icon name={open ? 'up' : 'down'} size={16} />
      </button>
      {open && (
        <div id={panelId} className="min-w-0 flex-1 pb-1.5 pt-1 sm:pb-0 sm:pt-0">
          <FilterControls f={f} compact />
        </div>
      )}
    </div>
  );
}

export function DfgPanel({
  analytics,
  controls = true,
  height = 520,
  large = false,
}: {
  analytics: Analytics | undefined;

  controls?: boolean;
  height?: number;
  large?: boolean;
}) {
  const { t } = useTranslation();
  const fs = useFullscreen<HTMLDivElement>();
  const [metric, setMetric] = useState<DfgMetric>('absolute');
  const [selectedTop, setTopVariants] = useState<number | null>(null);
  const variants = useMemo(() => analytics?.variants ?? [], [analytics?.variants]);
  const totalVariants = variants.length;
  const topVariants = selectedTop == null ? totalVariants : Math.min(selectedTop, totalVariants);
  const filtered = useMemo(() => {
    const complete = filterDfg(analytics?.dfg, { metric, activityPct: 100, pathPct: 100 });
    return highlightTopVariants(complete, variants, topVariants);
  }, [analytics?.dfg, metric, variants, topVariants]);
  const hasData = (analytics?.n ?? 0) > 0 && (analytics?.dfg?.edges?.length ?? 0) > 0;
  const filterState: FilterState = { metric, topVariants, totalVariants, setMetric, setTopVariants };
  const note = topVariants >= totalVariants ? t('dfg.allVariantsShown') : t('dfg.topVariantsShown', { shown: topVariants, total: totalVariants });

  if (!hasData) return <div data-testid="dfg-panel"><EmptyState title={t('empty.noResponses')} /></div>;

  return (

    <div ref={fs.ref} data-testid="dfg-panel" className={fs.active ? 'fixed inset-0 z-[70] bg-white' : undefined}>
      {fs.active ? (
        <DfgGraph
          graph={filtered}
          height="100%"
          bare
          large={large}
          showControls
          onToggleFullscreen={fs.toggle}
          fullscreen
          topLeft={controls ? <FloatingFilters f={filterState} /> : undefined}
          bottomLeft={
            <div className="flex items-center gap-0.5 rounded-lg bg-white/90 py-0.5 pl-2 pr-0.5">
              <p className="text-sm text-ink-soft" aria-live="polite" data-testid="dfg-hidden-note">{note}</p>
              {controls && <InfoTip text={t('tips.dfg.topVariants')} />}
            </div>
          }
        />
      ) : (
        <>
          {controls && (
            <div className="card mb-4 p-4 sm:px-6">
              <FilterControls f={filterState} />
            </div>
          )}
          <DfgGraph graph={filtered} height={height} large={large} showControls={controls} onToggleFullscreen={fs.toggle} fullscreen={false} />
          <div className="mt-3 flex items-center gap-0.5">
            <p className="text-sm text-ink-soft" aria-live="polite" data-testid="dfg-hidden-note">{note}</p>
            {controls && <InfoTip text={t('tips.dfg.topVariants')} />}
          </div>
        </>
      )}
    </div>
  );
}
