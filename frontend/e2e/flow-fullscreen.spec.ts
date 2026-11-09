import { expect, test, type Page } from '@playwright/test';
import { createSession, dashboardUrl, submitViaApi, traceQuestion } from './helpers';

async function sessionWithData(request: Parameters<typeof createSession>[0]) {
  const s = await createSession(request, { questions: [traceQuestion()] });
  const variants = [
    ['Wake up', 'Shower', 'Coffee', 'Leave'],
    ['Wake up', 'Check phone', 'Coffee', 'Leave'],
    ['Wake up', 'Coffee', 'Leave'],
  ];
  for (let i = 0; i < 9; i++) await submitViaApi(request, s, variants[i % 3]);
  return s;
}

const tablistOverflow = (page: Page) =>
  page.getByRole('tablist').evaluate((el) => ({
    horizontal: el.scrollWidth - el.clientWidth,
    vertical: el.scrollHeight - el.clientHeight,
    scrollbarW: (el as HTMLElement).offsetWidth - el.clientWidth,
    scrollbarH: (el as HTMLElement).offsetHeight - el.clientHeight,
  }));

const box = async (loc: ReturnType<Page['getByTestId']>) => {
  const b = (await loc.boundingBox())!;
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
};

test('process model full screen: the canvas is the viewport, controls float on top, Esc and the button leave', async ({ page, request }) => {
  const s = await sessionWithData(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(dashboardUrl(s));
  await page.getByTestId('tab-flow').click();
  const canvas = page.getByTestId('dfg-canvas');
  await expect(canvas).toBeVisible();

  const toggle = page.getByTestId('dfg-fullscreen');
  await expect(toggle).toContainText('Full screen');
  await expect(toggle).toHaveAttribute('aria-label', 'Show the process model full screen');

  await expect(toggle).not.toHaveAttribute('title', /.+/);
  await expect(toggle).toHaveAccessibleDescription(/Press Esc to leave/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Exit full screen');

  await expect.poll(() => box(canvas)).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

  const filters = page.getByTestId('dfg-filters');
  await expect(filters).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('dfg-variants')).toBeVisible();
  const fb = await box(filters);
  expect(fb.x).toBeLessThan(40);
  expect(fb.y).toBeLessThan(40);
  expect(fb.height).toBeLessThan(120);

  const tb = await box(toggle);
  expect(tb.x + tb.width).toBeGreaterThan(1280 - 40);
  expect(tb.y).toBeLessThan(40);
  const zb = await box(page.getByTestId('dfg-zoom'));
  expect(zb.x + zb.width).toBeGreaterThan(1280 - 40);
  expect(zb.y + zb.height).toBeGreaterThan(800 - 40);
  await expect(page.getByTestId('dfg-hidden-note')).toBeVisible();

  await page.getByTestId('dfg-filters-toggle').click();
  await expect(page.getByTestId('dfg-variants')).toHaveCount(0);
  expect(await box(canvas)).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  await page.getByTestId('dfg-filters-toggle').click();
  await expect(page.getByTestId('dfg-variants')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toContainText('Full screen');
  await expect.poll(async () => (await box(canvas)).width).toBeLessThan(1280);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

for (const width of [1024, 1280, 1920]) {
  test(`full screen filter bar stays one compact row at ${width}px`, async ({ page, request }) => {
    const s = await sessionWithData(request);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(dashboardUrl(s));
    await page.getByTestId('tab-flow').click();
    await page.getByTestId('dfg-fullscreen').click();
    await expect(page.getByTestId('dfg-variants')).toBeVisible();

    await page.evaluate(() => document.fonts.ready);
    const fb = await box(page.getByTestId('dfg-filters'));
    expect(fb.height, `filter bar ${fb.width}x${fb.height}`).toBeLessThan(120);
    expect(fb.x + fb.width).toBeLessThanOrEqual(width);
  });
}

test('full screen on a phone: filters start collapsed behind a "Filters" button', async ({ page, request }) => {
  const s = await sessionWithData(request);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(dashboardUrl(s));
  await page.getByTestId('tab-flow').click();
  await page.getByTestId('dfg-fullscreen').click();
  const canvas = page.getByTestId('dfg-canvas');
  await expect.poll(() => box(canvas)).toEqual({ x: 0, y: 0, width: 375, height: 812 });
  await expect(page.getByTestId('dfg-filters')).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('dfg-variants')).toHaveCount(0);
  await expect(page.getByTestId('dfg-filters-toggle')).toContainText('Filters');
  await page.getByTestId('dfg-filters-toggle').click();
  await expect(page.getByTestId('dfg-variants')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByTestId('dfg-fullscreen').click();
  await expect(page.getByTestId('dfg-fullscreen')).toHaveAttribute('aria-pressed', 'false');
});

test('display mode offers the full-screen process model without filter controls', async ({ page, request }) => {
  const s = await sessionWithData(request);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/display/${s.code}?key=${encodeURIComponent(s.displayKey)}`);
  const toggle = page.getByTestId('dfg-fullscreen');
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId('dfg-variants')).toHaveCount(0);
  await toggle.click();
  await expect.poll(() => box(page.getByTestId('dfg-canvas'))).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  await expect(page.getByTestId('dfg-filters')).toHaveCount(0);
  await expect(page.getByTestId('dfg-zoom')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});
for (const width of [360, 375]) {
  test(`German result tabs (plus the "i" at the end of the row) fit without scrolling at ${width}px`, async ({ page, request }) => {
    const s = await sessionWithData(request);
    await page.addInitScript(() => localStorage.setItem('processpoll:lang', 'de'));
    await page.setViewportSize({ width, height: 800 });
    await page.goto(dashboardUrl(s));
    await expect(page.getByTestId('tab-variants')).toHaveText('Varianten');
    for (const tab of ['tab-flow', 'tab-consensus', 'tab-groups', 'tab-variants']) {
      await page.getByTestId(tab).click();
      const o = await page.getByRole('tablist').first().evaluate((el) => ({ horizontal: el.scrollWidth - el.clientWidth, vertical: el.scrollHeight - el.clientHeight }));
      expect(o, `${tab} @${width}`).toEqual({ horizontal: 0, vertical: 0 });
    }
  });
}

for (const width of [375, 768, 1280]) {
  test(`result tabs show no scrollbars at ${width}px`, async ({ page, request }) => {
    const s = await sessionWithData(request);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(dashboardUrl(s));
    await expect(page.getByTestId('tab-variants')).toBeVisible();
    for (const tab of ['tab-flow', 'tab-consensus', 'tab-variants']) {
      await page.getByTestId(tab).click();
      const o = await tablistOverflow(page);
      expect(o, `${tab} @${width}`).toEqual({ horizontal: 0, vertical: 0, scrollbarW: 0, scrollbarH: 0 });
    }
  });
}
