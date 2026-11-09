import { describe, expect, it } from 'vitest';
import { computePosition, type Box } from './tooltipPosition';

const vp = { width: 400, height: 600 };
const tip = { width: 200, height: 60 };
const box = (left: number, top: number, w = 24, h = 24): Box => ({ left, top, right: left + w, bottom: top + h });

describe('computePosition', () => {
  it('puts the tooltip above and centred when there is room', () => {
    const p = computePosition(box(188, 300), tip, vp, 'top');
    expect(p.placement).toBe('top');
    expect(p.left).toBe(100);
    expect(p.top).toBe(300 - 8 - 60);
  });
  it('flips below when there is no room above', () => {
    const p = computePosition(box(188, 20), tip, vp, 'top');
    expect(p.placement).toBe('bottom');
    expect(p.top).toBe(20 + 24 + 8);
  });
  it('flips above when there is no room below', () => {
    const p = computePosition(box(188, 570), tip, vp, 'bottom');
    expect(p.placement).toBe('top');
  });
  it('clamps horizontally into the viewport (left and right edge)', () => {
    expect(computePosition(box(0, 300), tip, vp, 'top').left).toBe(8);
    expect(computePosition(box(380, 300), tip, vp, 'top').left).toBe(400 - 200 - 8);
  });
  it('supports left/right placement and vertical clamping', () => {
    const r = computePosition(box(20, 300), tip, vp, 'right');
    expect(r.placement).toBe('right');
    expect(r.left).toBe(20 + 24 + 8);
    const l = computePosition(box(360, 2), tip, vp, 'left');
    expect(l.placement).toBe('left');
    expect(l.top).toBe(8);
  });
  it('falls back to the cross axis when neither side along the axis fits', () => {

    const p = computePosition(box(300, 280), { width: 200, height: 590 }, vp, 'top');
    expect(p.placement).toBe('left');
    expect(p.top).toBe(8);
  });
  it('never returns coordinates outside the viewport, even for a tooltip wider than the viewport', () => {
    const p = computePosition(box(200, 300), { width: 500, height: 60 }, vp, 'top');
    expect(p.left).toBe(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
});
