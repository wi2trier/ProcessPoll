import { expect, test } from '@playwright/test';
import { addStep, createSession, newParticipant, openParticipant, stepTexts, traceQuestion } from './helpers';

test('select & sort: chips append, used chips are disabled when repeats are off', async ({ browser, request }) => {
  const s = await createSession(request, {
    questions: [traceQuestion({ mode: 'select_sort', allow_repeats: false, activities: ['Wake up', 'Shower', 'Coffee', 'Leave'] })],
  });
  const page = await openParticipant(browser, s.code);
  await expect(page.getByTestId('pool-chip')).toHaveCount(4);
  await expect(page.getByTestId('trace-input')).toHaveCount(0);

  await page.getByRole('button', { name: 'Add Shower' }).click();
  await expect(page.getByRole('button', { name: /Add Shower/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Add Wake up' }).click();
  await expect.poll(() => stepTexts(page)).toEqual(['Shower', 'Wake up']);
  await expect(page.getByTestId('pool-chip').and(page.locator(':disabled'))).toHaveCount(2);

  await page.getByRole('button', { name: 'Move Wake up up' }).click();
  await expect.poll(() => stepTexts(page)).toEqual(['Wake up', 'Shower']);

  await page.getByRole('button', { name: 'Remove Shower' }).click();
  await expect(page.getByRole('button', { name: 'Add Shower' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add Coffee' }).click();

  await page.getByTestId('trace-submit').click();
  await expect(page.getByTestId('submit-success')).toBeVisible();

  const res = await request.get(`/api/v1/sessions/${s.code}/admin`, { headers: { 'X-Admin-Key': s.adminKey } });
  expect((await res.json()).submitted).toBe(1);
});

test('free entry with repeats off prevents duplicates and enforces the minimum', async ({ browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion({ allow_repeats: false, min_steps: 2 })] });
  const page = await newParticipant(browser, s.code);
  await addStep(page, 'Coffee');
  await page.getByTestId('trace-input').fill('coffee');
  await expect(page.getByText(/already in your list/i)).toBeVisible();
  await expect(page.getByTestId('trace-add')).toBeDisabled();
  await page.getByTestId('trace-input').press('Enter');
  await expect(page.getByTestId('trace-item')).toHaveCount(1);

  await page.getByTestId('trace-submit').click();
  await expect(page.getByText('Add at least 2 steps.')).toBeVisible();
  await expect(page.getByTestId('submit-success')).toHaveCount(0);

  await page.getByTestId('trace-input').fill('Leave');
  await page.getByTestId('trace-add').click();
  await page.getByTestId('trace-submit').click();
  await expect(page.getByTestId('submit-success')).toBeVisible();
});
