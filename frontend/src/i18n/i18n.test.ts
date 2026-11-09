import { afterEach, describe, expect, it, vi } from 'vitest';
import de from './de.json';
import en from './en.json';

describe('default language', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
  });

  async function freshI18n() {
    vi.resetModules();
    return (await import('./index')).default;
  }

  it('is English even when the browser prefers German', async () => {
    localStorage.clear();
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('de-DE');
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['de-DE', 'de']);
    const i18n = await freshI18n();
    expect(i18n.resolvedLanguage).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('switches to German only after an explicit choice and remembers it', async () => {
    const i18n = await freshI18n();
    await i18n.changeLanguage('de');
    expect(i18n.resolvedLanguage).toBe('de');
    expect(localStorage.getItem('processpoll:lang')).toBe('de');
    expect(document.documentElement.lang).toBe('de');
    const again = await freshI18n();
    expect(again.resolvedLanguage).toBe('de');
  });
});

function flat(o: Record<string, unknown>, p = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));
}

describe('translations', () => {
  const e = flat(en).sort();
  const d = flat(de).sort();
  it('de and en have the same keys', () => {
    expect(d.filter((k) => !e.includes(k))).toEqual([]);
    expect(e.filter((k) => !d.includes(k))).toEqual([]);
  });
  it('have no empty strings and matching placeholders', () => {
    const get = (o: unknown, key: string) => key.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)[k], o) as string;
    for (const k of e) {
      const a = get(en, k);
      const b = get(de, k);
      expect(a.trim(), k).not.toBe('');
      expect(b.trim(), k).not.toBe('');
      const ph = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
      expect(ph(b), k).toBe(ph(a));
    }
  });
});
