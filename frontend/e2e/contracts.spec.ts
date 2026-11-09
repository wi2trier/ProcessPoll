import { expect, test } from '@playwright/test';
import { addStep, createSession, dashboardUrl, newParticipant, openHostMenu, roleQuestion, submitViaApi, traceQuestion } from './helpers';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('503 busy: the dashboard keeps its data, shows no error, and recovers after Retry-After', async ({ page, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  for (let i = 0; i < 3; i++) await submitViaApi(request, s, ['Wake up', 'Coffee', 'Leave']);
  let busy = false;
  let busyHits = 0;
  await page.route('**/api/v1/sessions/*/analytics*', async (route) => {
    if (!busy) return route.continue();
    busyHits++;
    return route.fulfill(json(503, { detail: 'busy', message: 'busy' }, { 'Retry-After': '1' }));
  });
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('kpi-responses')).toHaveText('3');

  busy = true;
  for (let i = 0; i < 2; i++) await submitViaApi(request, s, ['Wake up', 'Shower', 'Leave']);

  await expect.poll(() => busyHits, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('kpi-responses')).toHaveText('3');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('variants-list')).toBeVisible();

  busy = false;
  await expect(page.getByTestId('kpi-responses')).toHaveText('5', { timeout: 15_000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('autocomplete ignores 503 and 429 silently', async ({ page, browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  await submitViaApi(request, s, ['Wake up', 'Coffee']);
  const p = await newParticipant(browser, s.code);
  let status = 503;
  await p.route('**/labels/suggest*', (route) => route.fulfill(json(status, { detail: status === 503 ? 'busy' : 'rate_limited', message: 'x' }, { 'Retry-After': '2' })));
  await p.getByTestId('trace-input').fill('Wa');
  await p.waitForTimeout(500);
  await expect(p.getByRole('listbox')).toHaveCount(0);
  await expect(p.getByRole('alert')).toHaveCount(0);
  status = 429;
  await p.getByTestId('trace-input').fill('Wak');
  await p.waitForTimeout(500);
  await expect(p.getByRole('alert')).toHaveCount(0);

  await p.getByTestId('trace-input').press('Enter');
  await addStep(p, 'Leave');
  await expect(p.getByTestId('trace-item')).toHaveCount(2);
  void page;
});

test('429 on an unknown join code shows a friendly "too many attempts" screen without hammering the endpoint', async ({ page }) => {
  let hits = 0;
  await page.route('**/api/v1/sessions/ZZZZ-98', (route) => {
    hits++;
    return route.fulfill(json(429, { detail: 'rate_limited', message: 'slow down' }, { 'Retry-After': '1' }));
  });
  await page.goto('/p/ZZZZ-98');
  const screen = page.getByTestId('too-many-attempts');
  await expect(screen).toBeVisible();
  await expect(screen).toContainText('Too many attempts');
  await expect(screen).toContainText('Wait a moment, then try again.');
  await page.waitForTimeout(1500);
  expect(hits).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => hits).toBe(2);
});

test('429 message is translated', async ({ browser }) => {
  const ctx = await browser.newContext({ locale: 'en-US' });
  await ctx.addInitScript(() => localStorage.setItem('processpoll:lang', 'de'));
  const page = await ctx.newPage();
  await page.route('**/api/v1/sessions/ZZZZ-97', (route) => route.fulfill(json(429, { detail: 'rate_limited', message: 'x' })));
  await page.goto('/p/ZZZZ-97');
  await expect(page.getByTestId('too-many-attempts')).toContainText('Zu viele Versuche');
  await ctx.close();
});

test('changing k_min in the settings dialog updates the group comparison without a reload', async ({ page, request }) => {
  const s = await createSession(request, { questions: [traceQuestion(), roleQuestion()], settings: { k_min: 5 } });
  const roleQ = s.questionIds[1];
  for (let i = 0; i < 6; i++) await submitViaApi(request, s, ['Wake up', 'Shower', 'Leave'], [{ question_id: roleQ, value: { value: 'Student' } }]);
  for (let i = 0; i < 2; i++) await submitViaApi(request, s, ['Wake up', 'Coffee', 'Leave'], [{ question_id: roleQ, value: { value: 'Lecturer' } }]);
  await page.goto(dashboardUrl(s));
  await page.getByTestId('tab-groups').click();
  const compare = page.getByTestId('compare-panel');
  await expect(compare.getByTestId('dfg-mini')).toHaveCount(1);
  await expect(compare.getByText(/1 group hidden: fewer than 5 responses/)).toBeVisible();

  await openHostMenu(page);
  await page.getByTestId('host-settings').click();
  await page.getByLabel('Minimum group size').fill('2');
  await page.getByTestId('settings-save').click();
  await expect(compare.getByTestId('dfg-mini')).toHaveCount(2);
  await expect(compare.getByText(/group hidden/)).toHaveCount(0);
});

test('question text and settings changes reach an open dashboard (version tick)', async ({ page, request }) => {
  const s = await createSession(request, { questions: [traceQuestion(), roleQuestion()], settings: { k_min: 5 } });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('question-title')).toHaveText('What is your typical morning routine?');
  const h = { 'X-Admin-Key': s.adminKey };
  const r1 = await request.patch(`/api/v1/sessions/${s.code}/questions/${s.questionIds[0]}`, { headers: h, data: { prompt: 'A reworded question?' } });
  expect(r1.ok()).toBeTruthy();
  await expect(page.getByTestId('question-title')).toHaveText('A reworded question?');

  for (let i = 0; i < 2; i++) await submitViaApi(request, s, ['Wake up', 'Leave'], [{ question_id: s.questionIds[1], value: { value: 'Student' } }]);
  await page.getByTestId('tab-groups').click();
  await expect(page.getByTestId('compare-panel').getByText('No group is large enough yet')).toBeVisible();
  const r2 = await request.patch(`/api/v1/sessions/${s.code}`, { headers: h, data: { settings: { k_min: 2 } } });
  expect(r2.ok()).toBeTruthy();
  await expect(page.getByTestId('compare-panel').getByTestId('dfg-mini')).toHaveCount(1);
  await expect(page.getByTestId('compare-panel').getByText(/fewer than 5 responses/)).toHaveCount(0);
});
test('overlapping groups (multiple choice) get a warning', async ({ page, request }) => {
  const multi = { type: 'multiple_choice', prompt: 'Tools', help: null, required: false, config: { options: ['Slides', 'Video'] } };
  const s = await createSession(request, { questions: [traceQuestion(), multi], settings: { k_min: 3 } });
  for (let i = 0; i < 4; i++) await submitViaApi(request, s, ['Wake up', 'Coffee', 'Leave'], [{ question_id: s.questionIds[1], value: { values: ['Slides', 'Video'] } }]);
  await page.goto(dashboardUrl(s));
  await page.getByTestId('tab-groups').click();
  await expect(page.getByTestId('compare-panel').getByText(/People can be in several groups/)).toBeVisible();
});

test('literal __start__ labels are shown unmasked and a split first step reads "After Start"', async ({ page, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  for (let i = 0; i < 6; i++) await submitViaApi(request, s, ['Wake up', 'Coffee', 'Leave']);
  for (let i = 0; i < 6; i++) await submitViaApi(request, s, ['__start__', 'Coffee', 'Leave']);
  await page.goto(dashboardUrl(s));
  const list = page.getByTestId('variants-list');
  await expect(list).toContainText('__start__');
  expect((await list.textContent()) ?? '').not.toContain('\\');
  await page.getByTestId('tab-consensus').click();
  const hot = page.getByTestId('hotspot').filter({ hasText: 'After' }).first();
  await expect(hot).toContainText('Start');
  await expect(hot).toContainText('Wake up');
  expect((await page.getByTestId('consensus-panel').textContent()) ?? '').not.toContain('\\');
  await page.getByTestId('tab-flow').click();
  await expect(page.getByTestId('dfg-canvas')).toBeVisible();
});

test('privacy links point to generic operator privacy information', async ({ page, browser, request }) => {
  await page.goto('/privacy');
  await expect(page.getByTestId('privacy-page')).toBeVisible();
  await expect(page.getByTestId('privacy-page')).toContainText('Privacy information must be provided by the operator');

  const s = await createSession(request, { questions: [traceQuestion()] });
  const p = await newParticipant(browser, s.code);
  await expect(p.getByText("Please don't enter personal data.")).toBeVisible();
  await expect(p.getByTestId('privacy-link').first()).toHaveAttribute('href', '/privacy');
  await expect(p.getByText(/no name or IP address is stored/i)).toBeVisible();
});
