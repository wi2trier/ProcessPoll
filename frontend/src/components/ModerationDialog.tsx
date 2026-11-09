import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Auth } from '../api/client';
import { useLabels } from '../api/hooks';
import type { AliasIn, LabelRow } from '../api/types';
import { formatPercent } from '../lib/stats';
import { ActivityChip } from './ActivityChip';
import { Icon } from './Icon';
import { FieldLabel, IconTip, InfoTip } from './Tooltip';
import { Banner, Drawer, ErrorBox, Spinner } from './ui';

type Edit = { canonical: string | null; hidden: boolean };

export function effectiveAliases(rows: LabelRow[], edits: Record<string, Edit>): AliasIn[] {
  const out: AliasIn[] = [];
  for (const r of rows) {
    const e = edits[r.raw_key] ?? { canonical: r.canonical, hidden: r.hidden };
    if (e.canonical !== null || e.hidden) out.push({ raw_key: r.raw_key, canonical: e.canonical, hidden: e.hidden });
  }
  return out;
}

export function ModerationDialog({
  open,
  onClose,
  code,
  auth,
  questionId,
  questionName,
}: {
  open: boolean;
  onClose: () => void;
  code: string;
  auth: Auth;
  questionId: string | undefined;

  questionName?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const labels = useLabels(code, auth, questionId, open);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const rows = useMemo(() => [...(labels.data?.labels ?? [])].sort((a, b) => b.count - a.count || a.display.localeCompare(b.display)), [labels.data]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.raw_key, r])), [rows]);
  const total = rows.reduce((a, r) => a + r.count, 0);
  const eff = (r: LabelRow): Edit => edits[r.raw_key] ?? { canonical: r.canonical, hidden: r.hidden };

  const f = filter.trim().toLowerCase();
  const visible = rows.filter((r) => !f || r.display.toLowerCase().includes(f) || (eff(r).canonical ?? '').toLowerCase().includes(f));
  const dirty = Object.keys(edits).length > 0;

  const setEdit = (keys: string[], fn: (cur: Edit) => Edit) => {
    setSaved(false);
    setEdits((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        const r = byKey.get(k);
        if (!r) continue;
        const cur = next[k] ?? { canonical: r.canonical, hidden: r.hidden };
        const upd = fn(cur);
        if (upd.canonical === r.canonical && upd.hidden === r.hidden) delete next[k];
        else next[k] = upd;
      }
      return next;
    });
  };

  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      if (n.size > 0 && !target) {
        const best = rows.filter((r) => n.has(r.raw_key)).sort((a, b) => b.count - a.count)[0];
        if (best) setTarget(eff(best).canonical ?? best.display);
      }
      return n;
    });

  const merge = () => {
    const name = target.trim().replace(/\s+/g, ' ');
    if (!name || selected.size < 1) return;
    setEdit([...selected], (c) => ({ ...c, canonical: name }));
    setSelected(new Set());
    setTarget('');
  };

  const save = async () => {
    if (!questionId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.putAliases(code, auth, questionId, effectiveAliases(rows, edits));
      setEdits({});
      setSaved(true);
      await Promise.all([qc.invalidateQueries({ queryKey: ['labels', code] }), qc.invalidateQueries({ queryKey: ['session', code] })]);
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  const suggestions = (labels.data?.suggestions ?? []).filter((s) => s.raw_keys.every((k) => byKey.has(k)) && s.raw_keys.some((k) => eff(byKey.get(k) as LabelRow).canonical !== s.proposed_canonical));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('moderation.title')}
      footer={
        <>
          {dirty && (
            <button type="button" className="btn-ghost" onClick={() => { setEdits({}); setSaved(false); }}>
              {t('moderation.discard')}
            </button>
          )}
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={!dirty || saving} data-testid="moderation-save">
            {t('moderation.save', { count: Object.keys(edits).length })}
          </button>
        </>
      }
    >
      <p className="mb-1 flex items-start gap-1 text-ink-soft"><span>{t('moderation.intro')}</span><InfoTip text={t('tips.moderation.merge')} /></p>
      {questionName && <p className="mb-5 text-sm font-semibold text-ink" data-testid="moderation-question">{t('moderation.forQuestion', { name: questionName })}</p>}
      {labels.isPending ? (
        <Spinner />
      ) : labels.isError ? (
        <ErrorBox error={labels.error} onRetry={() => void labels.refetch()} />
      ) : rows.length === 0 ? (
        <Banner tone="info">{t('moderation.empty')}</Banner>
      ) : (
        <div className="space-y-8">
          {saved && <Banner tone="success" live>{t('moderation.saved')}</Banner>}
          {saveError != null && <ErrorBox error={saveError} />}

          {suggestions.length > 0 && (
            <section aria-labelledby="mod-sugg">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 id="mod-sugg" className="flex items-center gap-0.5 text-lg font-bold">{t('moderation.suggestions')}<InfoTip text={t('tips.moderation.suggestions')} /></h3>
                <button type="button" className="btn-secondary btn-sm" data-testid="accept-all" onClick={() => suggestions.forEach((s) => setEdit(s.raw_keys, (c) => ({ ...c, canonical: s.proposed_canonical })))}>
                  {t('moderation.acceptAll', { count: suggestions.length })}
                </button>
              </div>
              <ul className="space-y-3">
                {suggestions.slice(0, 8).map((s) => (
                  <li key={s.raw_keys.join('|')} className="rounded-xl border border-line bg-surface p-3" data-testid="merge-suggestion">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {s.raw_keys.map((k) => <ActivityChip key={k} label={byKey.get(k)?.display ?? k} size="sm" className="!bg-white" />)}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <p className="flex min-w-0 items-center gap-2 font-bold"><Icon name="next" size={16} className="shrink-0" /> <span className="truncate">{s.proposed_canonical}</span></p>
                      <button type="button" className="btn-primary btn-sm shrink-0" onClick={() => setEdit(s.raw_keys, (c) => ({ ...c, canonical: s.proposed_canonical }))}>
                        {t('moderation.accept')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="mod-labels">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h3 id="mod-labels" className="mr-auto text-lg font-bold">{t('moderation.labels', { count: rows.length })}</h3>
              <label className="sr-only" htmlFor="mod-filter">{t('moderation.filter')}</label>
              <input id="mod-filter" className="input input-sm !w-44" placeholder={t('moderation.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>

            <div className="mb-3 rounded-xl border border-line bg-surface p-3" role="group" aria-label={t('moderation.bulk')}>
              <FieldLabel htmlFor="mod-target" tip={t('tips.moderation.merge')}>{t('moderation.mergeInto')}</FieldLabel>
              <div className="flex flex-wrap gap-2">
                <input id="mod-target" className="input input-sm min-w-[10rem] flex-1" value={target} maxLength={120} onChange={(e) => setTarget(e.target.value)} placeholder={t('moderation.targetPlaceholder')} data-testid="merge-target" />
                <button type="button" className="btn-primary btn-sm" disabled={selected.size < 1 || !target.trim()} onClick={merge} data-testid="merge-apply">
                  <Icon name="merge" size={16} /> {t('moderation.merge', { count: selected.size })}
                </button>
                <button type="button" className="btn-secondary btn-sm" disabled={selected.size < 1} onClick={() => { setEdit([...selected], (c) => ({ ...c, hidden: true })); setSelected(new Set()); }}>
                  <Icon name="eyeoff" size={16} /> {t('moderation.hide')}
                </button>
                <InfoTip text={t('tips.moderation.hide')} className="self-center" />
              </div>
            </div>

            <table className="w-full text-left">
              <thead className="sr-only">
                <tr>
                  <th>{t('moderation.select')}</th>
                  <th>{t('moderation.colLabel')}</th>
                  <th>{t('moderation.colCount')}</th>
                  <th>{t('moderation.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const e = eff(r);
                  const changed = !!edits[r.raw_key];
                  return (
                    <tr key={r.raw_key} className={`border-t border-line ${changed ? 'bg-orange-light' : ''}`} data-testid="label-row">
                      <td className="w-10 py-2 pl-1 pr-2">
                        <input type="checkbox" className="h-5 w-5 accent-ink" checked={selected.has(r.raw_key)} onChange={() => toggle(r.raw_key)} aria-label={t('moderation.selectLabel', { label: r.display })} />
                      </td>
                      <td className={`py-2 pr-2 font-semibold ${e.hidden ? 'text-ink-soft line-through' : ''}`}>
                        {r.display}
                        {e.canonical !== null && <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-brand-tint px-2 py-0.5 text-sm font-semibold">→ {e.canonical}</span>}
                        {e.hidden && <span className="ml-2 rounded-md bg-line px-2 py-0.5 text-sm font-semibold no-underline">{t('moderation.hidden')}</span>}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-2 text-right tabular-nums">
                        {r.count} <span className="text-sm text-ink-soft">{formatPercent(total ? r.count / total : 0)}</span>
                      </td>
                      <td className="whitespace-nowrap py-2 text-right">
                        <IconTip label={t(e.hidden ? 'moderation.unhideLabel' : 'moderation.hideLabel', { label: r.display })} placement="left">
                          <button type="button" className="btn-icon !h-9 !w-9" onClick={() => setEdit([r.raw_key], (c) => ({ ...c, hidden: !c.hidden }))} aria-label={t(e.hidden ? 'moderation.unhideLabel' : 'moderation.hideLabel', { label: r.display })}>
                            <Icon name="eyeoff" size={16} />
                          </button>
                        </IconTip>
                        {e.canonical !== null && (
                          <IconTip label={t('moderation.clearAliasLabel', { label: r.display })} placement="left">
                            <button type="button" className="btn-icon !h-9 !w-9" onClick={() => setEdit([r.raw_key], (c) => ({ ...c, canonical: null }))} aria-label={t('moderation.clearAliasLabel', { label: r.display })}>
                              <Icon name="undo" size={16} />
                            </button>
                          </IconTip>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </Drawer>
  );
}
