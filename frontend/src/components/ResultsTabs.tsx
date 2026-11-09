import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Analytics } from '../api/types';
import { ConsensusPanel, EmptyState, VariantsPanel } from './AnalyticsPanels';
import { DfgPanel } from './DfgPanel';
import { Tabs } from './ui';

export type ResultTab = 'variants' | 'flow' | 'consensus' | 'groups';

export function ResultsTabs({
  analytics,
  groups,
  large = false,
  initial = 'variants',
  flowHeight = 560,
  flowControls = true,
}: {
  analytics: Analytics | undefined;
  groups?: ReactNode;
  large?: boolean;
  initial?: ResultTab;
  flowHeight?: number;
  flowControls?: boolean;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ResultTab>(initial);
  const tabs: { id: ResultTab; label: string; testId: string; tip: string }[] = [
    { id: 'variants', label: t('tabs.variants'), testId: 'tab-variants', tip: t('tips.tabs.variants') },
    { id: 'flow', label: t('tabs.flow'), testId: 'tab-flow', tip: t('tips.tabs.flow') },
    { id: 'consensus', label: t('tabs.consensus'), testId: 'tab-consensus', tip: t('tips.tabs.consensus') },
  ];
  if (groups) tabs.push({ id: 'groups', label: t('tabs.groups'), testId: 'tab-groups', tip: t('tips.tabs.groups') });
  const active = tabs.some((x) => x.id === tab) ? tab : 'variants';
  return (
    <div>
      <Tabs tabs={tabs} value={active} onChange={setTab} label={t('tabs.label')} large={large} />
      <div key={active} id="tabpanel" role="tabpanel" aria-labelledby={`tab-${active}`} className="mt-6 animate-[fadein_.2s_ease-out]">
        {analytics?.suppressed && active !== 'groups' ? (
          <div data-testid="suppressed"><EmptyState title={t('analytics.suppressed')} text={t('analytics.suppressedText')} /></div>
        ) : (
          <>
        {active === 'variants' && <VariantsPanel analytics={analytics} large={large} initial={large ? 5 : 6} />}
        {active === 'flow' && <DfgPanel analytics={analytics} large={large} height={flowHeight} controls={flowControls} />}
        {active === 'consensus' && <ConsensusPanel analytics={analytics} large={large} />}
        {active === 'groups' && groups}
          </>
        )}
      </div>
    </div>
  );
}
