import { expect, test, type Page } from '@playwright/test';
import { createSession, dashboardUrl, submitViaApi, traceQuestion } from './helpers';

const A = ['Wake up', 'Shower', 'Leave'];
const B = ['Wake up', 'Coffee', 'Leave'];
const C = ['Wake up', 'Check phone', 'Leave'];
const key = (steps: string[]) => steps.join('>');

const order = (page: Page) => page.getByTestId('variant-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-variant')));

async function startSampler(page: Page, variant: string) {
  await page.evaluate((v) => {
    const w = window as unknown as { __samples: number[]; __stop: boolean };
    w.__samples = [];
    w.__stop = false;
    const tick = () => {
      const row = document.querySelector(`[data-variant="${v}"]`);
      if (row) w.__samples.push(row.getBoundingClientRect().top);
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, variant);
}

async function finishSampler(page: Page): Promise<number[]> {
  await page.waitForFunction(() => document.getAnimations().length === 0);
  return page.evaluate(() => {
    const w = window as unknown as { __samples: number[]; __stop: boolean };
    w.__stop = true;
    return w.__samples;
  });
}
async function setup(request: Parameters<typeof createSession>[0]) {
  const s = await createSession(request, { questions: [traceQuestion()] });
  for (let i = 0; i < 3; i++) await submitViaApi(request, s, A);
  for (let i = 0; i < 2; i++) await submitViaApi(request, s, B);
  await submitViaApi(request, s, C);
  return s;
}

test('a variant that gains responses glides up the list instead of jumping', async ({ page, request }) => {
  const s = await setup(request);
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('variant-row')).toHaveCount(3);
  expect(await order(page)).toEqual([key(A), key(B), key(C)]);
  const rows = page.getByTestId('variant-row');
  const startTop = (await rows.nth(2).boundingBox())!.y;
  const rowElement = await rows.nth(2).elementHandle();

  await startSampler(page, key(C));
  for (let i = 0; i < 3; i++) await submitViaApi(request, s, C);

  await expect.poll(() => order(page)).toEqual([key(C), key(A), key(B)]);
  const samples = await finishSampler(page);

  expect(await rows.nth(0).elementHandle().then((h) => h!.evaluate((a, b) => a === b, rowElement))).toBe(true);

  await expect(rows.nth(0).getByTestId('variant-rank')).toHaveText('#1');
  await expect(rows.nth(0).getByTestId('variant-share')).toHaveText('44%');

  const endTop = samples[samples.length - 1];
  expect(endTop).toBeLessThan(startTop - 20);
  const between = new Set(samples.filter((y) => y < startTop - 2 && y > endTop + 2).map((y) => Math.round(y)));
  expect(between.size, `positions: ${samples.map((y) => Math.round(y)).join(',')}`).toBeGreaterThanOrEqual(3);
});

test('new variants fade in and the list keeps its stable order', async ({ page, request }) => {
  const s = await setup(request);
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('variant-row')).toHaveCount(3);
  const D = ['Wake up', 'Read news', 'Leave'];
  await submitViaApi(request, s, D);
  await expect(page.getByTestId('variant-row')).toHaveCount(4);

  expect((await order(page)).slice(0, 2)).toEqual([key(A), key(B)]);
  expect(await order(page)).toContain(key(D));
});

test('with reduced motion the rows change place without gliding', async ({ browser, request }) => {
  const s = await setup(request);
  const ctx = await browser.newContext({ reducedMotion: 'reduce', locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('variant-row')).toHaveCount(3);
  await startSampler(page, key(C));
  for (let i = 0; i < 3; i++) await submitViaApi(request, s, C);
  await expect.poll(() => order(page)).toEqual([key(C), key(A), key(B)]);
  const samples = await finishSampler(page);
  const distinct = new Set(samples.map((y) => Math.round(y)));

  expect(distinct.size, `positions: ${[...distinct].join(',')}`).toBeLessThanOrEqual(3);
  await ctx.close();
});
