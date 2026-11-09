import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFullscreen } from './useFullscreen';

afterEach(() => {
  document.body.style.overflow = '';
  vi.restoreAllMocks();
});

describe('useFullscreen', () => {
  it('toggles the overlay, locks page scroll and restores it', () => {
    const { result } = renderHook(() => useFullscreen());
    expect(result.current.active).toBe(false);
    act(() => result.current.enter());
    expect(result.current.active).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    act(() => result.current.exit());
    expect(result.current.active).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('leaves with Escape and ignores other keys', () => {
    const { result } = renderHook(() => useFullscreen());
    act(() => result.current.enter());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
    expect(result.current.active).toBe(true);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.active).toBe(false);
  });

  it('keeps the CSS overlay when the native Fullscreen API refuses', async () => {
    const { result } = renderHook(() => useFullscreen<HTMLDivElement>());
    const el = document.createElement('div');
    el.requestFullscreen = vi.fn().mockRejectedValue(new Error('denied'));
    (result.current.ref as { current: HTMLDivElement | null }).current = el;
    await act(async () => {
      result.current.enter();
      await Promise.resolve();
    });
    expect(el.requestFullscreen).toHaveBeenCalled();
    expect(result.current.active).toBe(true);
  });

  it('follows the browser when native full screen is left', async () => {
    const { result } = renderHook(() => useFullscreen<HTMLDivElement>());
    const el = document.createElement('div');
    el.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    (result.current.ref as { current: HTMLDivElement | null }).current = el;
    await act(async () => {
      result.current.enter();
      await Promise.resolve();
    });
    expect(result.current.active).toBe(true);

    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(result.current.active).toBe(false);
  });

  it('toggle switches both ways', () => {
    const { result } = renderHook(() => useFullscreen());
    act(() => result.current.toggle());
    expect(result.current.active).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.active).toBe(false);
  });
});
