import { useState } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { useTranslation } from 'react-i18next';
import type { Analytics } from '../api/types';
import { displayName } from '../lib/labels';
import { barColor, dotColor } from '../lib/colors';
import { formatNumber, formatPercent, formatWilson } from '../lib/stats';
import { ActivityChip, VariantChips } from './ActivityChip';
import { Icon, type IconName } from './Icon';
import { InfoTip } from './Tooltip';

export function useNodeName() {
  const { t } = useTranslation();
  return (id: string) => displayName(id, t('dfg.start'), t('dfg.end'));
}

export const LIST_ANIMATION = { duration: 280, easing: 'ease-out' } as const;

export function variantKey(steps: string[]): string {
  return steps.join('\u0001');
}

export function EmptyState({ title, text }: { title: string; text?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-edge/60 bg-surface px-6 py-14 text-center text-ink-soft">
      <p className="font-display text-xl font-bold text-ink">{title}</p>
      {text && <p className="mt-1">{text}</p>}
    </div>
  );
}

const KPI_TINT = {
  orange: 'bg-orange-light text-orange-dark',
  mint: 'bg-brand-tint text-brand',
  lavender: 'bg-lavender text-[#6B4FB0]',
} as const;

export function BigNumbers({ analytics, large = false }: { analytics: Analytics | undefined; large?: boolean }) {
  const { t } = useTranslation();
  const k = analytics?.kpis;
  const none = !k || k.n === 0;
  const items: { id: string; value: string; label: string; tip: string; icon: IconName; tint: keyof typeof KPI_TINT }[] = [
    { id: 'kpi-responses', value: k ? String(k.n) : '0', label: t('kpi.responses'), tip: t('tips.kpi.responses'), icon: 'users', tint: 'orange' },
    { id: 'kpi-variants', value: k ? String(k.n_variants) : '0', label: t('kpi.variants'), tip: t('tips.kpi.variants'), icon: 'list', tint: 'mint' },
    { id: 'kpi-top-variant', value: none ? '–' : formatPercent(k.top_variant_share), label: t('kpi.topVariant'), tip: t('tips.kpi.topVariant'), icon: 'chart', tint: 'lavender' },
  ];
  return (
    <dl className={`grid grid-cols-3 ${large ? 'gap-5' : 'gap-3 sm:gap-4'}`} data-testid="kpis">
      {items.map((it) => (
        <div key={it.id} data-testid="kpi-card" className={`card relative flex min-w-0 flex-col gap-3 ${large ? 'p-6 sm:flex-row sm:items-center sm:gap-5' : 'p-3.5 sm:flex-row sm:items-center sm:gap-4 sm:p-5'}`}>
          <span className={`flex shrink-0 items-center justify-center rounded-xl ${large ? 'h-16 w-16' : 'h-10 w-10 sm:h-12 sm:w-12'} ${KPI_TINT[it.tint]}`}>
            <Icon name={it.icon} size={large ? 30 : 22} />
          </span>
          <div className="min-w-0">
            <dd className={`font-display font-bold leading-none tracking-tight tabular-nums ${large ? 'text-[clamp(2.75rem,5vw,5rem)]' : 'text-[clamp(1.75rem,4.5vw,2.75rem)]'}`} data-testid={it.id}>{it.value}</dd>
            <dt className={`mt-1.5 font-medium leading-tight text-ink-soft ${large ? 'text-xl' : 'text-sm sm:text-base'}`}>{it.label}{!large && <span className="absolute right-0.5 top-0.5"><InfoTip text={it.tip} placement="bottom" /></span>}</dt>
          </div>
        </div>
      ))}
    </dl>
  );
}

export function VariantsPanel({ analytics, initial = 6, limit, large = false }: { analytics: Analytics | undefined; initial?: number; limit?: number; large?: boolean }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const [listRef] = useAutoAnimate<HTMLOListElement>(LIST_ANIMATION);
  const variants = analytics?.variants ?? [];
  const total = analytics?.kpis?.n_variants ?? variants.length;
  const visible = limit ? variants.slice(0, limit) : all ? variants : variants.slice(0, initial);
  const top = variants[0]?.share || 1;
  return (
    <div data-testid="variants-panel">
      {variants.length === 0 ? (
        <EmptyState title={t('empty.noResponses')} />
      ) : (
        <>
          <ol ref={listRef} className="flex flex-col gap-3" data-testid="variants-list">
            {visible.map((v, i) => {
              const key = variantKey(v.steps);
              return (

                <li key={key} data-testid="variant-row" data-variant={v.steps.join('>')} className="card relative overflow-hidden">
                  <div className={`flex flex-wrap items-stretch gap-x-3 gap-y-2.5 sm:flex-nowrap sm:gap-4 ${large ? 'p-5' : 'p-3.5 sm:p-4'}`}>
                    <span className="order-1 shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-slate sm:w-9 sm:pt-1.5" data-testid="variant-rank">#{i + 1}</span>
                    <div className="order-3 w-full min-w-0 self-center sm:order-2 sm:w-auto sm:flex-1"><VariantChips steps={v.steps} size={large ? 'md' : 'sm'} /></div>
                    <div className="order-2 ml-auto flex shrink-0 items-baseline gap-2 text-right sm:order-3 sm:w-20 sm:flex-col sm:items-stretch sm:justify-center sm:gap-0 sm:border-l sm:border-line sm:pl-4">
                      <span className={`font-display font-bold leading-none tabular-nums ${large ? 'text-3xl' : 'text-xl'}`} data-testid="variant-share">{formatPercent(v.share)}</span>
                      <span className="text-sm text-ink-soft sm:mt-1">{v.count}×</span>
                    </div>
                  </div>
                  {}
                  <div className="absolute inset-x-0 bottom-0 h-[3px]" aria-hidden="true">
                    <div className="h-full rounded-r-sm transition-[width] duration-300 ease-out" style={{ width: `${Math.max(1.5, Math.min(100, (v.share / Math.max(top, 0.25)) * 100))}%`, backgroundColor: dotColor(key) }} />
                  </div>
                </li>
              );
            })}
          </ol>
          {!limit && total > initial && (
            <button type="button" className="btn-secondary btn-sm mt-5" aria-expanded={all} onClick={() => setAll((x) => !x)}>
              {all ? t('variants.showFewer') : t('variants.showAll', { count: total })}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ContinuationBar({ items }: { items: { target: string; share: number }[] }) {
  return (
    <div className="mt-2 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-r-md bg-line" aria-hidden="true">
      {items.map((c, i) => (
        <span key={c.target} className="transition-[width] duration-300 ease-out" style={{ width: `${c.share * 100}%`, backgroundColor: barColor(i) }} />
      ))}
    </div>
  );
}

export function ConsensusPanel({ analytics, maxItems = 5, large = false }: { analytics: Analytics | undefined; maxItems?: number; large?: boolean }) {
  const { t } = useTranslation();
  const name = useNodeName();
  const [strongRef] = useAutoAnimate<HTMLUListElement>(LIST_ANIMATION);
  const [hotRef] = useAutoAnimate<HTMLUListElement>(LIST_ANIMATION);
  const c = analytics?.consensus;
  const n = analytics?.n ?? 0;
  const strong = (c?.strong ?? []).slice(0, maxItems);
  const hotspots = (c?.hotspots ?? []).slice(0, Math.min(maxItems, 4));
  const low = c?.low_support ?? [];
  if (!c || n === 0) return <div data-testid="consensus-panel"><EmptyState title={t('empty.noResponses')} /></div>;
  const h3 = `font-display text-lg font-bold ${large ? 'sm:text-2xl' : ''}`;
  const chip = large ? 'md' : 'sm';
  return (
    <div className="space-y-8" data-testid="consensus-panel">
      {c.medoid && (
        <section className="card p-4 sm:p-5">
          <h3 className={`${h3} flex items-center gap-0.5`}>{t('consensus.medoid')}{!large && <InfoTip text={t('tips.consensus.medoid')} />}</h3>
          <div className="mt-3"><VariantChips steps={c.medoid.steps} size={chip} /></div>
          <p className="mt-3 text-ink-soft">{t('consensus.meanDistance', { value: formatNumber(c.medoid.mean_distance, 2) })}</p>
          {c.medoid.approximate && <p className="mt-1 text-sm text-ink-soft" data-testid="medoid-approximate">{t('consensus.approximate')}</p>}
        </section>
      )}
      <div className="grid gap-8 lg:grid-cols-2">
        <section className="card p-4 sm:p-5">
          <h3 className={`${h3} flex items-center gap-2`}><span className="h-3 w-3 rounded-full bg-brand" aria-hidden="true" />{t('consensus.strong')}{!large && <InfoTip text={t('tips.consensus.strong')} className="-ml-1.5" />}</h3>
          {strong.length === 0 && <p className="mt-3 text-ink-soft">{t('consensus.noStrong')}</p>}
          <ul ref={strongRef} className="mt-4 flex flex-col gap-3">
            {strong.map((s) => (
              <li key={`${s.source}>${s.target}`} className="flex flex-wrap items-center gap-2">
                <ActivityChip label={name(s.source)} size={chip} quiet />
                <Icon name="next" size={16} className="text-[#AAB6C0]" />
                <ActivityChip label={name(s.target)} size={chip} quiet />
                <span className="font-display font-bold tabular-nums">{formatWilson(s.share, s.ci_low, s.ci_high)}</span>
                <span className="text-sm text-ink-soft">{t('consensus.supportShort', { n: s.support })}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card p-4 sm:p-5">
          <h3 className={`${h3} flex items-center gap-2`}><span className="h-3 w-3 rounded-full bg-orange" aria-hidden="true" />{t('consensus.divergence')}{!large && <InfoTip text={t('tips.consensus.divergence')} className="-ml-1.5" />}</h3>
          {hotspots.length === 0 && <p className="mt-3 text-ink-soft">{t('consensus.noHotspots')}</p>}
          <ul ref={hotRef} className="mt-4 flex flex-col gap-5">
            {hotspots.map((h) => (
              <li key={h.activity} data-testid="hotspot">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-ink-soft">{t('consensus.after')}</span>
                  <ActivityChip label={name(h.activity)} size={chip} quiet />
                  <span className="font-display font-bold tabular-nums">{formatWilson(h.dominant_share, h.ci_low, h.ci_high)}</span>
                </p>
                <ContinuationBar items={h.continuations.slice(0, 6)} />
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
                  {h.continuations.slice(0, 4).map((x, i) => (
                    <li key={x.target} className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: barColor(i) }} aria-hidden="true" />
                      {name(x.target)} {formatPercent(x.share)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {low.length > 0 && (
        <p className="flex items-start gap-0.5 text-ink-soft" role="note">
          <span>
            {t('consensus.lowSupport', { count: low.length, min: c.min_support })}
            <span className="sr-only"> {low.join(', ')}</span>
          </span>
          {!large && <InfoTip text={t('tips.consensus.lowSupport')} />}
        </p>
      )}
    </div>
  );
}
