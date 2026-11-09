export type Placement = 'top' | 'bottom' | 'left' | 'right';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Position {
  left: number;
  top: number;

  placement: Placement;
}

const OPPOSITE: Record<Placement, Placement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const CROSS: Record<Placement, Placement[]> = { top: ['left', 'right'], bottom: ['left', 'right'], left: ['top', 'bottom'], right: ['top', 'bottom'] };

function raw(trigger: Box, tip: { width: number; height: number }, side: Placement, gap: number): { left: number; top: number } {
  const cx = (trigger.left + trigger.right) / 2;
  const cy = (trigger.top + trigger.bottom) / 2;
  switch (side) {
    case 'top':
      return { left: cx - tip.width / 2, top: trigger.top - gap - tip.height };
    case 'bottom':
      return { left: cx - tip.width / 2, top: trigger.bottom + gap };
    case 'left':
      return { left: trigger.left - gap - tip.width, top: cy - tip.height / 2 };
    case 'right':
      return { left: trigger.right + gap, top: cy - tip.height / 2 };
  }
}

function fits(p: { left: number; top: number }, tip: { width: number; height: number }, side: Placement, vp: { width: number; height: number }, margin: number): boolean {
  if (side === 'top' || side === 'bottom') return p.top >= margin && p.top + tip.height <= vp.height - margin;
  return p.left >= margin && p.left + tip.width <= vp.width - margin;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

export function computePosition(
  trigger: Box,
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred: Placement = 'top',
  gap = 8,
  margin = 8,
): Position {
  const order = [preferred, OPPOSITE[preferred], ...CROSS[preferred]];
  let side = preferred;
  for (const s of order) {
    if (fits(raw(trigger, tip, s, gap), tip, s, viewport, margin)) {
      side = s;
      break;
    }
  }
  const p = raw(trigger, tip, side, gap);
  return {
    placement: side,
    left: Math.round(clamp(p.left, margin, viewport.width - tip.width - margin)),
    top: Math.round(clamp(p.top, margin, viewport.height - tip.height - margin)),
  };
}
