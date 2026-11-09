import { expect, test } from '@playwright/test';
import { addStep, createSession, dashboardUrl, newParticipant, openParticipant, traceQuestion } from './helpers';

test('wrong code on the join page shows a friendly error', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('join-code-input').fill('not a code');
  await page.getByTestId('join-submit').click();
  await expect(page.getByRole('alert')).toContainText(/doesn.t look like a code/);

  await page.getByTestId('join-code-input').fill('zzzz99');
  await page.getByTestId('join-submit').click();
  await expect(page).toHaveURL(/\/p\/ZZZZ-99$/);
  await expect(page.getByTestId('invalid-code')).toContainText('ZZZZ-99');
});

test('QR target /j/:code redirects to the participant page (case-insensitive)', async ({ page, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  await page.goto(`/j/${s.code.toLowerCase()}`);
  await expect(page).toHaveURL(new RegExp(`/p/${s.code}$`));
  await expect(page.getByTestId('trace-input')).toBeVisible();
});

test('submitting twice shows the already-submitted screen', async ({ browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  const page = await newParticipant(browser, s.code);
  await addStep(page, 'Wake up');
  await addStep(page, 'Leave');
  await page.getByTestId('trace-submit').click();
  await expect(page.getByTestId('submit-success')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('state-already-submitted')).toBeVisible();
  await expect(page.getByTestId('trace-submit')).toHaveCount(0);

  const res = await request.get(`/api/v1/sessions/${s.code}/admin`, { headers: { 'X-Admin-Key': s.adminKey } });
  expect((await res.json()).submitted).toBe(1);
});

test('a stale draft in another tab cannot submit twice (409 -> already submitted)', async ({ browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  const a = await newParticipant(browser, s.code);

  const b = await a.context().newPage();
  await b.goto(`/p/${s.code}`);
  await expect(b.getByTestId('trace-input')).toBeVisible();
  for (const p of [a, b]) {
    await addStep(p, 'Wake up');
    await addStep(p, 'Leave');
  }
  await a.getByTestId('trace-submit').click();
  await expect(a.getByTestId('submit-success')).toBeVisible();
  await b.getByTestId('trace-submit').click();
  await expect(b.getByTestId('state-already-submitted')).toBeVisible();
});

test('draft and closed states for participants', async ({ browser, request }) => {
  const draft = await createSession(request, { questions: [traceQuestion()], open: false });
  const p = await openParticipant(browser, draft.code);
  await expect(p.getByTestId('state-draft')).toBeVisible();

  const closed = await createSession(request, { questions: [traceQuestion()] });
  await request.patch(`/api/v1/sessions/${closed.code}`, { headers: { 'X-Admin-Key': closed.adminKey }, data: { status: 'closed' } });
  const q = await openParticipant(browser, closed.code);
  await expect(q.getByTestId('state-closed')).toBeVisible();
});

test('host dashboard with a wrong key shows an error, not data', async ({ page, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  await page.goto(dashboardUrl({ ...s, adminKey: 'definitely-wrong-key' }));
  await expect(page.getByTestId('invalid-key')).toBeVisible();
  await expect(page.getByTestId('kpi-responses')).toHaveCount(0);
});
