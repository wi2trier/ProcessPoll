import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { Drawer } from './ui';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Drawer focus', () => {
  it('keeps input focus across parent updates and uses the latest close handler', () => {
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const view = render(
      <Drawer open title="Labels" onClose={firstClose}>
        <input aria-label="Merge target" />
      </Drawer>,
    );
    const input = screen.getByRole('textbox', { name: 'Merge target' });
    input.focus();

    view.rerender(
      <Drawer open title="Labels" onClose={latestClose}>
        <input aria-label="Merge target" />
      </Drawer>,
    );

    expect(input).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledOnce();
  });
});
