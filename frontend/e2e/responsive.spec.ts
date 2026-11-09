import { expect, test } from '@playwright/test';
import { addStep, createSession, dashboardUrl, MOBILE, noHorizontalScroll, roleQuestion, submitViaApi, traceQuestion } from './helpers';

const LONG = 'A really long activity name that wraps over several lines on a phone screen';

test('phone: join page, wizard screens and thanks fit the viewport (no horizontal scroll)', async ({ browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion(), roleQuestion()], settings: { results_public: true } });
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('join-code-input')).toBeVisible();
  await noHorizontalScroll(page);

  await page.getByTestId('join-code-input').fill(s.code.toLowerCase());
  await page.getByTestId('join-submit').click();
  await expect(page.getByTestId('trace-input')).toBeVisible();
  await addStep(page, LONG);
  await addStep(page, 'Shower');
  await noHorizontalScroll(page);

  const box = await page.getByTestId('wizard-next').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(box!.y + box!.height).toBeLessThanOrEqual(812);

  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('question-single_choice')).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByTestId('trace-submit').click();
  await expect(page.getByTestId('submit-success')).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByTestId('see-results').click();
  await expect(page.getByTestId('kpi-responses')).toHaveText('1');
  await noHorizontalScroll(page);
  await ctx.close();
});

test('phone: host dashboard with data and the builder fit the viewport', async ({ browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion(), roleQuestion()] });
  for (let i = 0; i < 4; i++) await submitViaApi(request, s, ['Wake up', LONG, 'Leave'], [{ question_id: s.questionIds[1], value: { value: 'Student' } }]);
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('kpi-responses')).toHaveText('4');
  await noHorizontalScroll(page);
  for (const tab of ['tab-flow', 'tab-consensus', 'tab-groups']) {
    await page.getByTestId(tab).click();
    await noHorizontalScroll(page);
  }
  await page.goto('/host/new');
  await page.getByTestId('template-morning').click();
  await expect(page.getByTestId('builder-question')).toHaveCount(3);
  await noHorizontalScroll(page);
  await ctx.close();
});

test('German: long words do not break the phone layout', async ({ browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  const ctx = await browser.newContext(MOBILE);
  await ctx.addInitScript(() => localStorage.setItem('processpoll:lang', 'de'));
  const page = await ctx.newPage();
  await page.goto(`/p/${s.code}`);
  await expect(page.getByTestId('trace-submit')).toHaveText('Absenden');
  await page.getByTestId('trace-submit').click();
  await expect(page.getByRole('alert')).toContainText('Bitte beantworten Sie diese Frage.');
  await noHorizontalScroll(page);
  await ctx.close();
});

test('German host dashboard fits the phone viewport', async ({ browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion(), roleQuestion()] });
  for (let i = 0; i < 3; i++) await submitViaApi(request, s, ['Wake up', LONG, 'Leave'], [{ question_id: s.questionIds[1], value: { value: 'Student' } }]);
  const ctx = await browser.newContext(MOBILE);
  await ctx.addInitScript(() => localStorage.setItem('processpoll:lang', 'de'));
  const page = await ctx.newPage();
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('kpi-responses')).toHaveText('3');
  await noHorizontalScroll(page);
  for (const tab of ['tab-flow', 'tab-consensus', 'tab-groups']) {
    await page.getByTestId(tab).click();
    await noHorizontalScroll(page);
  }
  await ctx.close();
});

test('display mode scales on a full-HD projector without scrolling sideways', async ({ browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  await submitViaApi(request, s, ['Wake up', 'Shower', 'Leave']);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(`/display/${s.code}?key=${encodeURIComponent(s.displayKey)}`);
  await expect(page.getByTestId('kpi-responses')).toHaveText('1');
  await expect(page.getByTestId('dfg-canvas')).toBeVisible();
  await noHorizontalScroll(page);

  const fs = await page.getByTestId('session-code').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect(fs).toBeGreaterThanOrEqual(48);
  await ctx.close();
});
