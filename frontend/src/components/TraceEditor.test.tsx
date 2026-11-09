import { useState } from 'react';
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n';
import { TraceEditor } from './TraceEditor';
import { withTraceDefaults } from '../lib/traceLogic';
import type { TraceConfig } from '../api/types';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function Host({ cfg, initial = [], onValue, fetchSuggestions }: { cfg: Partial<TraceConfig>; initial?: string[]; onValue?: (v: string[]) => void; fetchSuggestions?: (q: string) => Promise<string[]> }) {
  const [v, setV] = useState<string[]>(initial);
  return (
    <TraceEditor
      config={withTraceDefaults(cfg)}
      value={v}
      fetchSuggestions={fetchSuggestions}
      onChange={(x) => {
        setV(x);
        onValue?.(x);
      }}
    />
  );
}
const labels = () => screen.queryAllByTestId('trace-item').map((li) => within(li).getAllByText(/./)[1]?.textContent ?? '');

describe('TraceEditor (free)', () => {
  it('adds steps with Enter and with the add button, trims and clears the input', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Host cfg={{}} onValue={onValue} />);
    const input = screen.getByTestId('trace-input');
    await user.type(input, '  Wake   up {Enter}');
    await user.type(input, 'Shower');
    await user.click(screen.getByTestId('trace-add'));
    expect(onValue).toHaveBeenLastCalledWith(['Wake up', 'Shower']);
    expect(screen.getAllByTestId('trace-item')).toHaveLength(2);
    expect(input).toHaveValue('');
  });

  it('removes and moves steps with the buttons', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Host cfg={{}} initial={['A', 'B', 'C']} onValue={onValue} />);
    await user.click(screen.getByRole('button', { name: 'Move C up' }));
    expect(onValue).toHaveBeenLastCalledWith(['A', 'C', 'B']);
    await user.click(screen.getByRole('button', { name: 'Move A down' }));
    expect(onValue).toHaveBeenLastCalledWith(['C', 'A', 'B']);
    await user.click(screen.getByRole('button', { name: 'Remove A' }));
    expect(onValue).toHaveBeenLastCalledWith(['C', 'B']);
    expect(screen.getByRole('button', { name: 'Move C up' })).toBeDisabled();
  });

  it('prevents duplicates when repeats are off and warns', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Host cfg={{ allow_repeats: false }} initial={['Coffee']} onValue={onValue} />);
    await user.type(screen.getByTestId('trace-input'), 'coffee');
    expect(screen.getByTestId('trace-add')).toBeDisabled();
    expect(screen.getByText(/already in your list/i)).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onValue).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('trace-item')).toHaveLength(1);
  });

  it('allows duplicates when repeats are on', async () => {
    const user = userEvent.setup();
    render(<Host cfg={{ allow_repeats: true }} initial={['Coffee']} />);
    await user.type(screen.getByTestId('trace-input'), 'Coffee{Enter}');
    expect(screen.getAllByTestId('trace-item')).toHaveLength(2);
  });

  it('stops at max steps and says so', async () => {
    const user = userEvent.setup();
    render(<Host cfg={{ max_steps: 2, min_steps: 1 }} initial={['A']} />);
    await user.type(screen.getByTestId('trace-input'), 'B{Enter}');
    expect(screen.getAllByTestId('trace-item')).toHaveLength(2);
    expect(screen.getByTestId('trace-input')).toBeDisabled();
    expect(screen.getByTestId('trace-hint')).toHaveTextContent('Maximum of 2 steps');
  });

  it('only mentions restrictions, never defaults', () => {
    const { unmount } = render(<Host cfg={{ allow_repeats: true, min_steps: 1 }} />);
    expect(screen.getByTestId('trace-hint')).toBeEmptyDOMElement();
    expect(screen.queryByText(/Allow repeats/)).toBeNull();
    unmount();
    render(<Host cfg={{ allow_repeats: false, min_steps: 2 }} />);
    expect(screen.getByTestId('trace-hint')).toHaveTextContent('Each step once · At least 2 steps');
  });

  it('offers remote suggestions and ignores fetch failures', async () => {
    const user = userEvent.setup();
    const fetchSuggestions = vi.fn().mockResolvedValue(['Make coffee']);
    const { unmount } = render(<Host cfg={{ suggest_existing: true }} fetchSuggestions={fetchSuggestions} />);
    await user.type(screen.getByTestId('trace-input'), 'cof');
    const opt = await screen.findByRole('option', { name: 'Make coffee' });
    await user.click(opt);
    expect(screen.getAllByTestId('trace-item')).toHaveLength(1);
    unmount();

    const failing = vi.fn().mockRejectedValue(new Error('403'));
    render(<Host cfg={{ suggest_existing: true }} fetchSuggestions={failing} />);
    await user.type(screen.getByTestId('trace-input'), 'cof');
    await waitFor(() => expect(failing).toHaveBeenCalled());
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByTestId('trace-input')).toBeEnabled();
  });
});

describe('TraceEditor inside another form', () => {
  it('adds with Enter and the add button without submitting the outer form', async () => {
    const user = userEvent.setup();
    const outer = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={outer}>
        <Host cfg={{}} />
        <button type="submit">outer submit</button>
      </form>,
    );
    await user.type(screen.getByTestId('trace-input'), 'A{Enter}');
    await user.type(screen.getByTestId('trace-input'), 'B');
    await user.click(screen.getByTestId('trace-add'));
    expect(screen.getAllByTestId('trace-item')).toHaveLength(2);
    expect(outer).not.toHaveBeenCalled();
    expect(document.querySelectorAll('form form')).toHaveLength(0);
  });
});

describe('TraceEditor (select_sort)', () => {
  const cfg = { mode: 'select_sort' as const, activities: ['Wake up', 'Shower', 'Coffee'], allow_repeats: false, allow_custom: false };

  it('appends pool chips on tap and disables used ones', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Host cfg={cfg} onValue={onValue} />);
    expect(screen.queryByTestId('trace-input')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add Shower' }));
    await user.click(screen.getByRole('button', { name: 'Add Wake up' }));
    expect(onValue).toHaveBeenLastCalledWith(['Shower', 'Wake up']);
    const chips = screen.getAllByTestId('pool-chip');
    expect(chips.filter((c) => (c as HTMLButtonElement).disabled)).toHaveLength(2);
    expect(labels()).toHaveLength(2);
  });

  it('keeps chips enabled when repeats are allowed', async () => {
    const user = userEvent.setup();
    render(<Host cfg={{ ...cfg, allow_repeats: true }} />);
    await user.click(screen.getByRole('button', { name: 'Add Coffee' }));
    await user.click(screen.getByRole('button', { name: /Add Coffee/ }));
    expect(screen.getAllByTestId('trace-item')).toHaveLength(2);
  });

  it('shows a custom input only when allow_custom', async () => {
    const user = userEvent.setup();
    render(<Host cfg={{ ...cfg, allow_custom: true }} />);
    await user.type(screen.getByTestId('trace-input'), 'Walk dog{Enter}');
    expect(screen.getAllByTestId('trace-item')).toHaveLength(1);
  });
});
