export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function mixHex(a: string, b: string, t: number): string {
  const ch = (i: number) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t);
  return `#${[1, 3, 5].map((i) => ch(i).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export const INK = '#162D33';
const WHITE = '#FFFFFF';

export function deepen(color: string, against: string, min = 3.2): string {
  let t = 0;
  let c = color;
  while (contrast(c, against) < min && t < 1) {
    t = Math.min(1, t + 0.04);
    c = mixHex(color, INK, t);
  }
  return c;
}

export const FLOW_PALETTE = [
  { name: 'orange', bg: '#FDF2E0', accent: '#E98A10' },
  { name: 'purple', bg: '#F1EAFB', accent: '#7557BC' },
  { name: 'teal', bg: '#E2F3EF', accent: '#087C73' },
  { name: 'blue', bg: '#E8F2FC', accent: '#4386BD' },
  { name: 'green', bg: '#EEF3DE', accent: '#81952D' },
  { name: 'pink', bg: '#F8E8ED', accent: '#BE718A' },
] as const;
const GRAY_PALETTE = { name: 'gray', bg: '#EEF1F4', accent: '#60717D' } as const;

export const CATEGORICAL: readonly string[] = FLOW_PALETTE.map((p) => deepen(p.accent, WHITE));
export const DOT_COUNT = CATEGORICAL.length;
const GRAY_LINE = deepen(GRAY_PALETTE.accent, WHITE);

export function colorKey(label: string): string {
  return label.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function dotColor(label: string): string {
  return CATEGORICAL[hashString(colorKey(label)) % CATEGORICAL.length];
}

export function barColor(rank: number): string {
  return CATEGORICAL[((rank % CATEGORICAL.length) + CATEGORICAL.length) % CATEGORICAL.length];
}

export const GROUP_COLORS: readonly string[] = [...CATEGORICAL, GRAY_LINE];
export function groupColor(index: number): string {
  return GROUP_COLORS[index % GROUP_COLORS.length];
}

export interface ActivityTone {

  bg: string;

  icon: string;

  ink: string;
}

const toTone = (p: { bg: string; accent: string }): ActivityTone => ({ bg: p.bg, icon: deepen(p.accent, p.bg), ink: INK });
const TONES: ActivityTone[] = FLOW_PALETTE.map(toTone);
export const ACTIVITY_TONES: readonly ActivityTone[] = TONES;

export function activityTone(label: string): ActivityTone {
  return TONES[hashString(colorKey(label)) % TONES.length];
}
