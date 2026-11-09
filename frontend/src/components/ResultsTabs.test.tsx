import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../i18n';
import type { Analytics } from '../api/types';
import { ConsensusPanel } from './AnalyticsPanels';
import { ResultsTabs } from './ResultsTabs';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const base: Analytics = {
  version: 1,
  question_id: 'q',
  n: 0,
  filter: null,
  kpis: { n: 0, n_variants: 0, variant_ratio: 0, top_variant_share: 0, coverage_top5: 0, mean_length: 0, start_agreement: 0, end_agreement: 0 },
  variants: [],
  activities: [],
  dfg: { nodes: [], edges: [] },
  consensus: { min_support: 5, theta: 0.7, strong: [], hotspots: [], low_support: [], medoid: null },
};

describe('suppressed analytics (filtered view below k_min)', () => {
  it('shows a short notice instead of empty charts', () => {
    render(<MemoryRouter><ResultsTabs analytics={{ ...base, suppressed: true }} /></MemoryRouter>);
    expect(screen.getByTestId('suppressed')).toHaveTextContent('Too few responses to show this group');
    expect(screen.queryByTestId('variants-list')).toBeNull();
  });
  it('does not hide the Groups tab', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ResultsTabs analytics={{ ...base, suppressed: true }} groups={<p>compare view</p>} /></MemoryRouter>);
    await user.click(screen.getByTestId('tab-groups'));
    expect(screen.getByText('compare view')).toBeInTheDocument();
    expect(screen.queryByTestId('suppressed')).toBeNull();
  });
  it('shows the normal empty state for an ordinary empty session', () => {
    render(<MemoryRouter><ResultsTabs analytics={base} /></MemoryRouter>);
    expect(screen.queryByTestId('suppressed')).toBeNull();
    expect(screen.getByText('No responses yet')).toBeInTheDocument();
  });
});

describe('consensus details from newer backends', () => {
  const withConsensus = (c: Partial<Analytics['consensus']>): Analytics => ({
    ...base,
    n: 20,
    consensus: { ...base.consensus, ...c },
  });

  it('names the virtual start node and unmasks literal __start__ labels', () => {
    render(
      <ConsensusPanel
        analytics={withConsensus({
          hotspots: [{ activity: '__start__', support: 20, dominant_share: 0.6, ci_low: 0.4, ci_high: 0.77, entropy_norm: 0.97, disagreement_mass: 8, continuations: [{ target: 'Wake up', count: 12, share: 0.6 }, { target: '\\__start__', count: 8, share: 0.4 }] }],
          strong: [{ source: '__start__', target: 'Wake up', support: 20, share: 0.9, ci_low: 0.7, ci_high: 0.97 }],
        })}
      />,
    );
    const hot = screen.getByTestId('hotspot');
    expect(hot).toHaveTextContent('After');
    expect(hot).toHaveTextContent('Start');
    expect(hot).toHaveTextContent('Wake up 60%');
    expect(hot).toHaveTextContent('__start__ 40%');
    expect(hot.textContent).not.toContain('\\');
  });

  it('says when the typical process is approximate', () => {
    const { rerender } = render(<ConsensusPanel analytics={withConsensus({ medoid: { steps: ['A', 'B'], mean_distance: 0.4, approximate: true } })} />);
    expect(screen.getByTestId('medoid-approximate')).toHaveTextContent('Based on the most frequent variants');
    rerender(<ConsensusPanel analytics={withConsensus({ medoid: { steps: ['A', 'B'], mean_distance: 0.4, approximate: false } })} />);
    expect(screen.queryByTestId('medoid-approximate')).toBeNull();
  });
});
