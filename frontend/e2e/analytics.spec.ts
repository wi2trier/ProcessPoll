import { expect, test } from '@playwright/test';
import { createSession, dashboardUrl, openHostMenu, roleQuestion, submitViaApi, traceQuestion } from './helpers';

test('group comparison shows one graph per group above k_min', async ({ page, request }) => {
  const s = await createSession(request, { questions: [traceQuestion(), roleQuestion()], settings: { k_min: 5 } });
  const roleQ = s.questionIds[1];
  for (let i = 0; i < 6; i++) {
    await submitViaApi(request, s, ['Wake up', 'Shower', 'Coffee', 'Leave'], [{ question_id: roleQ, value: { value: 'Student' } }]);
    await submitViaApi(request, s, ['Wake up', 'Check phone', 'Breakfast', 'Leave'], [{ question_id: roleQ, value: { value: 'Lecturer' } }]);
  }
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('kpi-responses')).toHaveText('12');
  await expect(page.getByTestId('kpi-variants')).toHaveText('2');

  await page.getByTestId('tab-groups').click();
  const compare = page.getByTestId('compare-panel');
  await expect(compare.getByTestId('compare-groups')).toBeVisible();
  await expect(compare.getByTestId('dfg-mini')).toHaveCount(2);
  await expect(compare.getByRole('heading', { name: 'Student n=6' })).toBeVisible();
  await expect(compare.getByRole('heading', { name: 'Lecturer n=6' })).toBeVisible();

  await compare.getByRole('tab', { name: 'Difference' }).click();
  await expect(compare.getByTestId('dfg-diff')).toBeVisible();
  await expect(compare.getByText('exploratory').first()).toBeVisible();
  await expect(compare.getByRole('table').first()).toBeVisible();
});

test('groups below k_min are hidden with an explanation', async ({ page, request }) => {
  const s = await createSession(request, { questions: [traceQuestion(), roleQuestion()], settings: { k_min: 5 } });
  const roleQ = s.questionIds[1];
  for (let i = 0; i < 6; i++) await submitViaApi(request, s, ['Wake up', 'Shower', 'Leave'], [{ question_id: roleQ, value: { value: 'Student' } }]);
  for (let i = 0; i < 2; i++) await submitViaApi(request, s, ['Wake up', 'Coffee', 'Leave'], [{ question_id: roleQ, value: { value: 'Lecturer' } }]);
  await page.goto(dashboardUrl(s));
  await page.getByTestId('tab-groups').click();
  const compare = page.getByTestId('compare-panel');
  await expect(compare.getByTestId('dfg-mini')).toHaveCount(1);
  await expect(compare.getByText(/1 group hidden: fewer than 5 responses/)).toBeVisible();
  await expect(compare.getByText('Lecturer (n=2)')).toBeVisible();
});

test('moderation: merging spelling variants reduces the number of variants', async ({ page, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  const spellings = ['Check mail', 'Check email', 'Check e-mail'];
  for (let i = 0; i < 6; i++) await submitViaApi(request, s, ['Wake up', spellings[i % 3], 'Leave']);
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('kpi-variants')).toHaveText('3');

  await openHostMenu(page);
  await page.getByTestId('open-moderation').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('label-row')).toHaveCount(5);
  for (const l of spellings) await dialog.getByRole('checkbox', { name: `Select ${l}` }).check();
  await dialog.getByTestId('merge-target').fill('Check email');
  await dialog.getByTestId('merge-apply').click();
  await expect(dialog.getByTestId('moderation-save')).toBeEnabled();
  await dialog.getByTestId('moderation-save').click();
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).last().click();

  await expect(page.getByTestId('kpi-variants')).toHaveText('1');
  await expect(page.getByTestId('kpi-responses')).toHaveText('6');
  await expect(page.getByTestId('variants-list')).toContainText('Check email');
  await expect(page.getByTestId('variants-list')).not.toContainText('Check e-mail');
});

test('moderation: hiding a label removes the step from the analysis', async ({ page, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  for (let i = 0; i < 4; i++) await submitViaApi(request, s, ['Wake up', i % 2 ? 'Um' : 'Uh', 'Leave']);
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('kpi-variants')).toHaveText('2');
  await openHostMenu(page);
  await page.getByTestId('open-moderation').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Hide Um' }).click();
  await dialog.getByRole('button', { name: 'Hide Uh' }).click();
  await dialog.getByTestId('moderation-save').click();
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await expect(page.getByTestId('kpi-variants')).toHaveText('1');
});
