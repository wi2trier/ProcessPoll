import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n';
import { IconTip, InfoTip, Tooltip } from './Tooltip';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
});

const TEXT = 'Explains the field in one or two sentences.';

describe('InfoTip', () => {
  it('opens on keyboard focus and is linked with aria-describedby', async () => {
    const user = userEvent.setup();
    render(<InfoTip text={TEXT} />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(TEXT);
    const btn = screen.getByTestId('infotip');
    expect(btn).toHaveFocus();
    expect(btn).toHaveAccessibleName('More information');

    expect(btn).toHaveAccessibleDescription(TEXT);
  });

  it('closes with Esc and does not let the Esc reach a dialog behind it', async () => {
    const user = userEvent.setup();
    const onDocKey = vi.fn();
    document.addEventListener('keydown', onDocKey);
    try {
      render(<InfoTip text={TEXT} />);
      await user.tab();
      await screen.findByRole('tooltip');
      onDocKey.mockClear();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(onDocKey).not.toHaveBeenCalled();

      await user.keyboard('{Escape}');
      expect(onDocKey).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onDocKey);
    }
  });

  it('closes on blur', async () => {
    const user = userEvent.setup();
    render(<><InfoTip text={TEXT} /><button type="button">next</button></>);
    await user.tab();
    await screen.findByRole('tooltip');
    await user.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on mouse hover (after a short delay) and closes when the pointer leaves', async () => {
    const user = userEvent.setup();
    render(<InfoTip text={TEXT} />);
    await user.hover(screen.getByTestId('infotip'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(TEXT);
    await user.unhover(screen.getByTestId('infotip'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('a mouse click pins the tooltip until the user clicks elsewhere', async () => {
    const user = userEvent.setup();
    render(<><InfoTip text={TEXT} /><p>elsewhere</p></>);
    await user.click(screen.getByTestId('infotip'));
    await screen.findByRole('tooltip');
    await user.unhover(screen.getByTestId('infotip'));
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await user.click(screen.getByText('elsewhere'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a tap on a touch screen toggles it, a tap outside closes it', async () => {
    const user = userEvent.setup();
    render(<><InfoTip text={TEXT} /><p>elsewhere</p></>);
    const btn = screen.getByTestId('infotip');
    await user.pointer({ keys: '[TouchA]', target: btn });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(TEXT);
    await user.pointer({ keys: '[TouchA]', target: btn });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    await user.pointer({ keys: '[TouchA]', target: btn });
    await screen.findByRole('tooltip');
    await user.pointer({ keys: '[TouchA]', target: screen.getByText('elsewhere') });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('shows only one tooltip at a time', async () => {
    const user = userEvent.setup();
    render(<><InfoTip text="First text" /><InfoTip text="Second text" /></>);
    const [a, b] = screen.getAllByTestId('infotip');
    await user.tab();
    expect(a).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('First text');
    await user.hover(b);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Second text'));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  });

  it('does not open from the focus that a mouse press causes (a click only toggles)', async () => {
    const user = userEvent.setup();
    render(<InfoTip text={TEXT} />);
    await user.pointer([{ keys: '[MouseLeft>]', target: screen.getByTestId('infotip') }]);

    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.pointer([{ keys: '[/MouseLeft]' }]);
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
  });

  it('is rendered in a portal on the body, outside overflow containers', async () => {
    const user = userEvent.setup();
    const { container } = render(<div style={{ overflow: 'hidden' }}><InfoTip text={TEXT} /></div>);
    await user.tab();
    const tip = await screen.findByRole('tooltip');
    expect(container.contains(tip)).toBe(false);
    expect(tip.parentElement).toBe(document.body);
    expect(tip.style.position).toBe('fixed');
  });

  it('uses the full-screen element as the portal target while in full screen', async () => {
    const user = userEvent.setup();
    const host = document.createElement('div');
    document.body.appendChild(host);
    Object.defineProperty(document, 'fullscreenElement', { value: host, configurable: true });
    render(<InfoTip text={TEXT} />);
    await user.tab();
    const tip = await screen.findByRole('tooltip');
    expect(tip.parentElement).toBe(host);
    host.remove();
  });
});

describe('Tooltip / IconTip', () => {
  it('IconTip shows the label visually without duplicating it for assistive technology', async () => {
    const user = userEvent.setup();
    render(
      <IconTip label="Zoom in">
        <button type="button" aria-label="Zoom in">+</button>
      </IconTip>,
    );
    await user.tab();
    await waitFor(() => expect(screen.getByText('Zoom in', { selector: 'div' })).toBeInTheDocument());
    expect(screen.queryByRole('tooltip')).toBeNull();
    const btn = screen.getByRole('button', { name: 'Zoom in' });
    expect(btn).not.toHaveAttribute('aria-describedby');
  });

  it('keeps the handlers of the wrapped element', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onFocus = vi.fn();
    render(
      <Tooltip content={TEXT}>
        <button type="button" onClick={onClick} onFocus={onFocus}>go</button>
      </Tooltip>,
    );
    await user.tab();
    expect(onFocus).toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('merges an existing aria-describedby instead of replacing it', () => {
    render(
      <>
        <p id="own">own description</p>
        <Tooltip content={TEXT}>
          <button type="button" aria-describedby="own">go</button>
        </Tooltip>
      </>,
    );
    expect(screen.getByRole('button', { name: 'go' })).toHaveAccessibleDescription(`own description ${TEXT}`);
  });
});
