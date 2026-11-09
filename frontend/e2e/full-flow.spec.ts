import { expect, test } from '@playwright/test';
import { addStep, finishWizard, newParticipant, openHostMenu, stepTexts } from './helpers';

test('host creates, starts, three participants submit, live dashboard, pause, close, export', async ({ page, browser, request }) => {

  await page.goto('/host/new');
  await page.getByTestId('template-morning').click();
  await expect(page.getByTestId('builder-question')).toHaveCount(3);
  await page.getByTestId('session-title').fill('E2E morning routine');
  await page.getByTestId('create-session').click();
  await expect(page.getByTestId('host-saved')).toBeVisible();
  const code = (await page.getByTestId('created-code').textContent())!.trim();
  const hostLink = await page.getByTestId('host-link').inputValue();
  expect(hostLink).toContain(`/host/${code}?key=`);
  const adminKey = new URL(hostLink).searchParams.get('key')!;
  await page.getByTestId('host-continue').click();

  await expect(page.getByTestId('status-badge').first()).toHaveText('Draft');
  await expect(page.getByTestId('waiting')).toBeVisible();
  await expect(page.getByTestId('session-code')).toHaveText(code);
  await page.getByTestId('host-start').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('status-badge').first()).toHaveText('Live');
  await expect(page.getByTestId('connection-indicator')).toHaveAttribute('data-state', 'live');

  const p1 = await newParticipant(browser, code);
  await addStep(p1, 'Wake up');
  await addStep(p1, 'Check phone');
  await addStep(p1, 'Coffee');
  await expect.poll(() => stepTexts(p1)).toEqual(['Wake up', 'Check phone', 'Coffee']);
  await p1.getByRole('button', { name: 'Move Coffee up' }).click();
  await p1.getByRole('button', { name: 'Move Coffee up' }).click();
  await expect.poll(() => stepTexts(p1)).toEqual(['Coffee', 'Wake up', 'Check phone']);
  await p1.getByRole('button', { name: 'Remove Coffee' }).click();
  await addStep(p1, 'Coffee');
  await expect.poll(() => stepTexts(p1)).toEqual(['Wake up', 'Check phone', 'Coffee']);
  await p1.getByTestId('wizard-next').click();
  await p1.getByText('Student', { exact: true }).click();
  await p1.getByTestId('wizard-next').click();
  await p1.getByTestId('trace-submit').click();
  await expect(p1.getByTestId('submit-success')).toBeVisible();

  await expect(page.getByTestId('kpi-responses')).toHaveText('1');

  const p2 = await newParticipant(browser, code);
  await p2.getByTestId('trace-input').fill('Wa');
  const option = p2.getByRole('option', { name: 'Wake up' });
  await expect(option).toBeVisible();
  await option.click();
  await addStep(p2, 'Coffee');
  await addStep(p2, 'Coffee');
  await expect(p2.getByTestId('trace-item')).toHaveCount(3);
  await p2.getByTestId('wizard-next').click();
  await p2.getByTestId('wizard-skip').click();
  await p2.getByTestId('wizard-skip').click();
  await expect(p2.getByTestId('submit-success')).toBeVisible();

  const p3 = await newParticipant(browser, code);
  for (const l of ['Wake up', 'Check phone', 'Coffee']) await addStep(p3, l);
  await finishWizard(p3, 2);
  await expect(p3.getByTestId('submit-success')).toBeVisible();

  await expect(page.getByTestId('kpi-responses')).toHaveText('3');
  await expect(page.getByTestId('kpi-variants')).toHaveText('2');
  await expect(page.getByTestId('variants-list').getByTestId('variant-row')).toHaveCount(2);
  await expect(page.getByTestId('variants-list').getByTestId('variant-row').first()).toContainText('2×');
  await page.getByTestId('tab-flow').click();
  await expect(page.getByTestId('dfg-canvas')).toBeVisible();

  const p4 = await newParticipant(browser, code);
  await page.getByTestId('host-pause').click();
  await expect(page.getByTestId('status-badge').first()).toHaveText('Paused');
  await expect(p4.getByTestId('state-paused')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('host-resume').click();
  await expect(page.getByTestId('status-badge').first()).toHaveText('Live');
  await expect(p4.getByTestId('trace-input')).toBeVisible({ timeout: 20_000 });

  await openHostMenu(page);
  await page.getByTestId('host-close').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('status-badge').first()).toHaveText('Closed');
  await expect(p4.getByTestId('state-closed')).toBeVisible({ timeout: 20_000 });

  await openHostMenu(page);
  const href = await page.getByTestId('export-csv').getAttribute('href');
  expect(href).toContain('format=csv');
  const res = await request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-disposition']).toContain('attachment');
  const csv = (await res.text()).replace(/^\uFEFF/, '');
  const lines = csv.trim().split(/\r?\n/);

  expect(lines[0]).toBe('case_id,position,activity,activity_raw,submitted_at,Role,Experience');
  expect(lines).toHaveLength(1 + 3 + 3 + 3);
  expect(csv).toContain('Wake up');

  expect((await request.get(href!.replace(adminKey, 'wrong'))).status()).toBeGreaterThanOrEqual(401);
});
