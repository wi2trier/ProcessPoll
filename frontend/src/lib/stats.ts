export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function formatPercent(share: number | null | undefined, digits = 0): string {
  if (share == null || !Number.isFinite(share)) return '–';
  return `${(share * 100).toFixed(digits)}%`;
}

export function formatWilson(share: number, low: number, high: number): string {
  const p = Math.round(clamp01(share) * 100);
  const lo = Math.round(clamp01(low) * 100);
  const hi = Math.round(clamp01(high) * 100);
  return `${p}% [${lo}–${hi}]`;
}

export function wilsonInterval(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: clamp01(centre - half), high: clamp01(centre + half) };
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(sec)}`;
}

export function parseIso(s: string): number {
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/i.test(s.trim());
  return Date.parse(hasTz || !/\d{2}:\d{2}/.test(s) ? s : `${s.trim()}Z`);
}

export function elapsedSeconds(openedAt: string | null | undefined, now: number = Date.now(), closedAt?: string | null): number | null {
  if (!openedAt) return null;
  const start = parseIso(openedAt);
  if (Number.isNaN(start)) return null;
  const end = closedAt ? parseIso(closedAt) : now;
  return Math.max(0, (Number.isNaN(end) ? now : end) - start) / 1000;
}

export function formatNumber(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '–';
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}
