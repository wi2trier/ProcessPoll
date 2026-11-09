export function normalizeJoinCode(input: string): string {
  let s = (input ?? '').trim();

  const m = s.match(/\/(?:j|p)\/([^/?#\s]+)/i);
  if (m) s = decodeURIComponent(m[1]);
  s = s
    .toUpperCase()
    .replace(/[‐-―−_]/g, '-')
    .replace(/\s+/g, '');
  const compact = s.match(/^([A-Z]{4})-?(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  return s;
}

export function isPlausibleJoinCode(code: string): boolean {
  return /^[A-Z0-9]{3,12}-[A-Z0-9]{1,6}$/.test(code);
}
