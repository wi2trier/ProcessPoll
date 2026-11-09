import { describe, expect, it } from 'vitest';
import { clamp01, parseIso, elapsedSeconds, formatDuration, formatNumber, formatPercent, formatWilson, wilsonInterval } from './stats';

describe('stats formatting', () => {
  it('formats percentages', () => {
    expect(formatPercent(0.384)).toBe('38%');
    expect(formatPercent(0.1234, 1)).toBe('12.3%');
    expect(formatPercent(undefined)).toBe('–');
    expect(formatPercent(NaN)).toBe('–');
  });
  it('formats Wilson text like "38% [30–47]"', () => {
    expect(formatWilson(0.38, 0.3, 0.47)).toBe('38% [30–47]');
    expect(formatWilson(1.2, -0.1, 2)).toBe('100% [0–100]');
  });
  it('computes the Wilson interval', () => {
    const { low, high } = wilsonInterval(38, 100);
    expect(low).toBeCloseTo(0.2909, 3);
    expect(high).toBeCloseTo(0.4783, 3);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
    const all = wilsonInterval(10, 10);
    expect(all.high).toBeCloseTo(1, 6);
    expect(all.low).toBeLessThan(1);
  });
  it('formats durations', () => {
    expect(formatDuration(754)).toBe('00:12:34');
    expect(formatDuration(3600 * 25 + 5)).toBe('25:00:05');
    expect(formatDuration(-5)).toBe('00:00:00');
    expect(formatDuration(NaN)).toBe('00:00:00');
  });
  it('computes elapsed seconds', () => {
    const now = Date.parse('2026-01-01T10:12:34Z');
    expect(elapsedSeconds('2026-01-01T10:00:00Z', now)).toBe(754);
    expect(elapsedSeconds(null, now)).toBeNull();
    expect(elapsedSeconds('garbage', now)).toBeNull();
    expect(elapsedSeconds('2026-01-01T10:00:00Z', now, '2026-01-01T10:01:00Z')).toBe(60);
  });
  it('treats timestamps without timezone as UTC', () => {
    expect(parseIso('2026-01-01T10:00:00')).toBe(Date.parse('2026-01-01T10:00:00Z'));
    expect(parseIso('2026-01-01T10:00:00+02:00')).toBe(Date.parse('2026-01-01T08:00:00Z'));
    expect(parseIso('2026-01-01T10:00:00.123456')).toBe(Date.parse('2026-01-01T10:00:00.123Z'));
    expect(elapsedSeconds('2026-01-01T10:00:00', Date.parse('2026-01-01T10:00:30Z'))).toBe(30);
  });
  it('clamps and formats numbers', () => {
    expect(clamp01(2)).toBe(1);
    expect(clamp01(-1)).toBe(0);
    expect(formatNumber(3)).toBe('3');
    expect(formatNumber(3.14159, 2)).toBe('3.14');
    expect(formatNumber(null)).toBe('–');
  });
});
