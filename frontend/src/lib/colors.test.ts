import { describe, expect, it } from 'vitest';
import { ACTIVITY_TONES, CATEGORICAL, DOT_COUNT, FLOW_PALETTE, GROUP_COLORS, INK, activityTone, barColor, colorKey, contrast, deepen, dotColor, groupColor, hashString, mixHex } from './colors';

const WHITE = '#FFFFFF';

describe('colour helpers', () => {
  it('mixes colours', () => {
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mixHex('#087C73', '#FFFFFF', 0)).toBe('#087C73');
  });
  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBe(1);
  });
  it('deepens a colour until it reaches the contrast, and leaves good colours alone', () => {
    const light = '#E98A10';
    expect(contrast(light, WHITE)).toBeLessThan(3);
    expect(contrast(deepen(light, WHITE), WHITE)).toBeGreaterThanOrEqual(3.2);
    expect(deepen('#087C73', WHITE)).toBe('#087C73');
  });
});

describe('label colours', () => {
  it('is stable for the same label', () => {
    expect(dotColor('Coffee')).toBe(dotColor('Coffee'));
  });
  it('ignores case, outer and inner whitespace', () => {
    expect(dotColor('  coffee  ')).toBe(dotColor('COFFEE'));
    expect(colorKey('Wake   up')).toBe('wake up');
    expect(dotColor('Wake   up')).toBe(dotColor('wake up'));
  });
  it('hashes deterministically (FNV-1a reference values)', () => {
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('a')).toBe(0xe40c292c);
  });
  it('spreads different labels over the palette', () => {
    const labels = ['Wake up', 'Shower', 'Coffee', 'Breakfast', 'Get dressed', 'Leave', 'Check phone', 'Bathroom', 'Brush teeth', 'Commute'];
    const used = new Set(labels.map(dotColor));
    expect(used.size).toBeGreaterThan(3);
    expect(used.size).toBeLessThanOrEqual(DOT_COUNT);
  });
  it('always returns palette colours', () => {
    for (const l of ['anything', '', 'Ünïcode ✓']) expect(CATEGORICAL).toContain(dotColor(l));
  });
  it('cycles bar and group colours', () => {
    expect(barColor(0)).toBe(barColor(DOT_COUNT));
    expect(barColor(-1)).toBe(barColor(DOT_COUNT - 1));
    expect(groupColor(0)).toBe(groupColor(GROUP_COLORS.length));
  });
  it('is derived from the 6 flow accents and keeps every line colour at >= 3:1 on white', () => {
    expect(CATEGORICAL).toHaveLength(FLOW_PALETTE.length);
    for (const c of [...CATEGORICAL, ...GROUP_COLORS]) expect(contrast(c, WHITE), c).toBeGreaterThanOrEqual(3);
  });
});

describe('text and brand colours (AA on white)', () => {
  it('headline ink and secondary text', () => {
    expect(contrast(INK, WHITE)).toBeGreaterThanOrEqual(7);
    expect(contrast('#62798A', WHITE)).toBeGreaterThanOrEqual(4.5);
  });
  it('teal primary: white text on the button and teal text on white', () => {
    expect(contrast(WHITE, '#087C73')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, '#06675F')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#087C73', WHITE)).toBeGreaterThanOrEqual(4.5);
  });
  it('orange accent text variant and error', () => {
    expect(contrast('#A85F00', WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#A85F00', '#FDF2E0')).toBeGreaterThanOrEqual(4);
    expect(contrast('#B3261E', WHITE)).toBeGreaterThanOrEqual(4.5);
  });
  it('control borders reach 3:1 on white; hairlines are decorative', () => {
    expect(contrast('#8794A2', WHITE)).toBeGreaterThanOrEqual(3);
  });
  it('muted metadata colour is only meant for non-essential text', () => {
    expect(contrast('#7B8994', WHITE)).toBeGreaterThanOrEqual(3.5);
    expect(contrast('#8C9AA8', WHITE)).toBeGreaterThan(2.5);
  });
});

describe('activity tones (pastel pills)', () => {
  it('is stable per label and case-insensitive', () => {
    expect(activityTone('Coffee')).toEqual(activityTone(' coffee '));
  });
  it('assigns every label by hash without interpreting its text', () => {
    expect(activityTone('Coffee')).toEqual(ACTIVITY_TONES[hashString(colorKey('Coffee')) % ACTIVITY_TONES.length]);
    expect(activityTone('xyzzy')).toEqual(ACTIVITY_TONES[hashString(colorKey('xyzzy')) % ACTIVITY_TONES.length]);
  });
  it('contains the 6 activity pastels', () => {
    expect(ACTIVITY_TONES.map((t) => t.bg)).toEqual(['#FDF2E0', '#F1EAFB', '#E2F3EF', '#E8F2FC', '#EEF3DE', '#F8E8ED']);
  });
  for (const [i, tone] of ACTIVITY_TONES.entries()) {
    it(`tone ${i} keeps icon >= 3:1 and text >= 7:1 on its pastel`, () => {
      expect(contrast(tone.icon, tone.bg), `icon ${tone.icon} on ${tone.bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(tone.ink, tone.bg), `ink on ${tone.bg}`).toBeGreaterThanOrEqual(7);
    });
  }
  it('pastels stay light', () => {
    for (const tone of ACTIVITY_TONES) expect(contrast(tone.bg, WHITE)).toBeLessThan(1.3);
  });
});
