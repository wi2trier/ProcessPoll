import { expect, test, type Page } from '@playwright/test';
import { addStep, createSession, dashboardUrl, newParticipant, openHostMenu, roleQuestion, submitViaApi, traceQuestion } from './helpers';

const DESCRIPTION = 'We collect everyday processes for a seminar. List the steps in the order you do them. There are no wrong answers.';
const TRACE_PROMPT = 'Describe how you start your day, from waking up until you leave home.';
const ROLE_PROMPT = 'What is your current role?';

async function fillQuestion(page: Page, index: number, prompt: string, label?: string) {
  const card = page.getByTestId('builder-question').nth(index);
  await card.getByTestId('builder-prompt').fill(prompt);
  if (label !== undefined) {
    const optional = card.getByTestId('builder-optional');
    if ((await optional.getAttribute('data-open')) !== 'true') await card.getByTestId('builder-optional-toggle').click();
    await card.getByTestId('builder-label').fill(label);
  }
  return card;
}

test('question and field label: builder -> participant sees the question, dashboard/display/compare/export use the label', async ({ page, browser, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto('/host/new');
  await page.getByTestId('template-empty').click();
  await page.getByTestId('session-title').fill('Start of the day');
  await page.getByTestId('session-description').fill(DESCRIPTION);
  await expect(page.getByText('/ 1000')).toContainText(`${DESCRIPTION.length} / 1000`);

  await page.getByTestId('add-trace').click();
  const trace = await fillQuestion(page, 0, TRACE_PROMPT);

  await expect(trace.getByTestId('builder-optional')).toHaveAttribute('data-open', 'false');
  await trace.getByTestId('builder-optional-toggle').click();
  await expect(trace.getByTestId('builder-preview')).toContainText(`Participants see: ${TRACE_PROMPT}`);
  await expect(trace.getByTestId('builder-preview')).toContainText(`Presentation shows: ${TRACE_PROMPT}`);
  await trace.getByTestId('builder-label').fill('Day start');
  await expect(trace.getByTestId('preview-presentation')).toHaveText('Day start');
  await expect(trace.getByTestId('preview-participants')).toHaveText(TRACE_PROMPT);

  await page.getByTestId('add-single_choice').click();
  const role = await fillQuestion(page, 1, ROLE_PROMPT, 'Role');
  await role.getByLabel('Options').fill('Student\nLecturer');
  await page.getByTestId('create-session').click();
  await expect(page.getByTestId('host-saved')).toBeVisible();
  const code = (await page.getByTestId('created-code').textContent())!.trim();
  const adminKey = new URL(await page.getByTestId('host-link').inputValue()).searchParams.get('key')!;
  const h = { 'X-Admin-Key': adminKey };
  await page.getByTestId('host-continue').click();

  const admin = await (await request.get(`/api/v1/sessions/${code}/admin`, { headers: h })).json();
  expect(admin.description).toBe(DESCRIPTION);
  expect(admin.questions.map((q: { prompt: string; label: string | null }) => [q.prompt, q.label])).toEqual([[TRACE_PROMPT, 'Day start'], [ROLE_PROMPT, 'Role']]);
  const displayKey: string = admin.display_key;

  await expect(page.getByTestId('question-title')).toHaveText('Day start');
  await expect(page.getByTestId('description-text')).toHaveText(DESCRIPTION);
  await page.getByTestId('host-start').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('status-badge').first()).toHaveText('Live');

  const p = await newParticipant(browser, code);
  await expect(p.getByTestId('poll-description')).toHaveText(DESCRIPTION);
  await expect(p.getByTestId('question-trace').getByRole('heading', { level: 1 })).toContainText(TRACE_PROMPT);
  await expect(p.getByText('Day start')).toHaveCount(0);
  await addStep(p, 'Wake up');
  await addStep(p, 'Coffee');
  await p.getByTestId('wizard-next').click();
  await expect(p.getByTestId('poll-intro')).toHaveCount(0);
  await expect(p.getByTestId('question-single_choice').getByRole('heading', { level: 1 })).toContainText(ROLE_PROMPT);
  await expect(p.getByText('Role', { exact: true })).toHaveCount(0);
  await p.getByText('Student', { exact: true }).click();
  await p.getByTestId('trace-submit').click();
  await expect(p.getByTestId('submit-success')).toBeVisible();
  await p.context().close();

  const qids: string[] = admin.questions.map((q: { id: string }) => q.id);
  for (let i = 0; i < 5; i++) await submitViaApi(request, { code, adminKey, displayKey, questionIds: qids }, ['Wake up', 'Coffee', 'Leave'], [{ question_id: qids[1], value: { value: 'Student' } }]);
  for (let i = 0; i < 5; i++) await submitViaApi(request, { code, adminKey, displayKey, questionIds: qids }, ['Wake up', 'Shower', 'Leave'], [{ question_id: qids[1], value: { value: 'Lecturer' } }]);

  await expect(page.getByTestId('kpi-responses')).toHaveText('11');
  await expect(page.getByTestId('question-title')).toHaveText('Day start');
  await page.getByTestId('tab-groups').click();
  const by = page.getByTestId('compare-groupby');
  await expect(by.locator('option')).toHaveText(['Role']);
  await expect(page.getByTestId('compare-group-by')).toHaveText('Groups by Role');

  await openHostMenu(page);
  await page.getByTestId('open-moderation').click();
  await expect(page.getByTestId('moderation-question')).toHaveText('Question: Day start');
  await page.keyboard.press('Escape');

  const disp = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await disp.goto(`/display/${code}?key=${displayKey}`);
  await expect(disp.getByTestId('display-title')).toHaveText('Day start');
  await expect(disp.getByTestId('description-text')).toContainText('We collect everyday processes');
  await disp.close();

  const csv = (await (await request.get(`/api/v1/sessions/${code}/export?format=csv&question_id=${qids[0]}`, { headers: h })).text()).replace(/^\uFEFF/, '');
  expect(csv.split(/\r?\n/)[0]).toBe('case_id,position,activity,activity_raw,submitted_at,Role');
  expect(csv).not.toContain(ROLE_PROMPT);
});

test('edit texts: description, question, field label and hint can be changed while the poll is live', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const s = await createSession(request, {
    questions: [traceQuestion({}, TRACE_PROMPT, 'Day start'), roleQuestion(ROLE_PROMPT, 'Role')],
    description: DESCRIPTION,
  });
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('question-title')).toHaveText('Day start');

  await openHostMenu(page);
  await page.getByTestId('edit-texts').click();
  const dialog = page.getByRole('dialog', { name: 'Edit texts' });
  await expect(dialog.getByTestId('texts-description')).toHaveValue(DESCRIPTION);
  const q1 = dialog.getByTestId('texts-question').first();
  await expect(q1.getByTestId('texts-prompt')).toHaveValue(TRACE_PROMPT);

  await expect(q1.getByTestId('texts-label')).toHaveValue('Day start');

  await dialog.getByTestId('texts-description').fill('A new, shorter intro.');
  await q1.getByTestId('texts-label').fill('Morning');
  await q1.getByTestId('texts-help').fill('Use short phrases.');
  await dialog.getByTestId('texts-save').click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByTestId('question-title')).toHaveText('Morning');
  await expect(page.getByTestId('description-text')).toHaveText('A new, shorter intro.');
  const pub = await (await request.get(`/api/v1/sessions/${s.code}`)).json();
  expect(pub.description).toBe('A new, shorter intro.');
  expect(pub.questions[0]).toMatchObject({ prompt: TRACE_PROMPT, label: 'Morning', help: 'Use short phrases.' });

  await openHostMenu(page);
  await page.getByTestId('edit-texts').click();
  const d2 = page.getByRole('dialog', { name: 'Edit texts' });
  await d2.getByTestId('texts-question').first().getByTestId('texts-label').fill('');
  await d2.getByTestId('texts-description').fill('');
  await d2.getByTestId('texts-save').click();
  await expect(page.getByTestId('question-title')).toHaveText(TRACE_PROMPT);
  await expect(page.getByTestId('description')).toHaveCount(0);
  const pub2 = await (await request.get(`/api/v1/sessions/${s.code}`)).json();
  expect(pub2.description).toBeNull();
  expect(pub2.questions[0].label).toBeNull();
});

test('a text change made in another tab reaches an open dashboard and an open display (version tick)', async ({ page, browser, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const s = await createSession(request, { questions: [traceQuestion({}, TRACE_PROMPT, 'Day start'), roleQuestion()], description: 'First intro.' });
  await page.goto(dashboardUrl(s));
  const disp = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await disp.goto(`/display/${s.code}?key=${s.displayKey}`);
  await expect(disp.getByTestId('display-title')).toHaveText('Day start');
  const h = { 'X-Admin-Key': s.adminKey };
  expect((await request.patch(`/api/v1/sessions/${s.code}/questions/${s.questionIds[0]}`, { headers: h, data: { label: 'Wake-up routine' } })).ok()).toBeTruthy();
  expect((await request.patch(`/api/v1/sessions/${s.code}`, { headers: h, data: { description: 'Second intro.' } })).ok()).toBeTruthy();
  await expect(page.getByTestId('question-title')).toHaveText('Wake-up routine');
  await expect(page.getByTestId('description-text')).toHaveText('Second intro.');
  await expect(disp.getByTestId('display-title')).toHaveText('Wake-up routine');
  await expect(disp.getByTestId('description-text')).toHaveText('Second intro.');
  await disp.close();
});

test('a long description is shown completely on the first participant screen', async ({ browser, request }) => {
  const long = 'This poll collects everyday processes from our cohort. '.repeat(8).trim();
  const s = await createSession(request, { questions: [traceQuestion()], description: long });
  const p = await newParticipant(browser, s.code);
  const text = p.getByTestId('poll-description');
  await expect(text).toHaveText(long);
  await expect(text).not.toHaveCSS('-webkit-line-clamp', '3');
  expect((await text.boundingBox())!.height).toBeGreaterThan(60);
  await expect(p.getByTestId('intro-toggle')).toHaveCount(0);
  await p.context().close();
});

test('without a description the participant screen is unchanged and the dashboard shows no description line', async ({ page, browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion()] });
  const p = await newParticipant(browser, s.code);
  await expect(p.getByTestId('poll-intro')).toHaveCount(0);
  await p.context().close();
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('question-title')).toHaveText('What is your typical morning routine?');
  await expect(page.getByTestId('description')).toHaveCount(0);
});

test('tooltips: "i" opens on keyboard focus, Esc closes only the tooltip, a modal behind it stays open', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const s = await createSession(request, { questions: [traceQuestion(), roleQuestion()] });
  await submitViaApi(request, s, ['Wake up', 'Leave']);
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('kpi-responses')).toHaveText('1');

  const tip = page.getByTestId('kpi-card').first().getByTestId('infotip');
  await tip.focus();
  const bubble = page.getByRole('tooltip');
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText('People who submitted an answer');
  await expect(tip).toHaveAccessibleDescription(/People who submitted an answer/);
  await page.keyboard.press('Escape');
  await expect(bubble).toHaveCount(0);

  await openHostMenu(page);
  await page.getByTestId('host-settings').click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await page.keyboard.press('Tab');
  await dialog.getByTestId('infotip').first().focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await tip.hover();
  const box = (await page.getByRole('tooltip').boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
});

test('tooltips: a tap toggles the "i" on a phone and stays inside the viewport', async ({ browser, request }) => {
  const s = await createSession(request, { questions: [traceQuestion(), roleQuestion()] });
  await submitViaApi(request, s, ['Wake up', 'Leave']);
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(dashboardUrl(s));
  await expect(page.getByTestId('kpi-responses')).toHaveText('1');
  const tip = page.getByTestId('kpi-card').last().getByTestId('infotip');
  await tip.tap();
  const bubble = page.getByRole('tooltip');
  await expect(bubble).toBeVisible();
  const box = (await bubble.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await tip.tap();
  await expect(bubble).toHaveCount(0);
  await tip.tap();
  await expect(bubble).toBeVisible();
  await page.getByTestId('question-title').tap();
  await expect(bubble).toHaveCount(0);
  await ctx.close();
});

test('tooltips: builder fields and icon-only buttons have explanations (EN and DE)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/host/new');
  await page.getByTestId('template-morning').click();
  await page.keyboard.press('Tab');
  const first = page.getByTestId('builder-question').first();

  expect(await first.getByTestId('infotip').count()).toBeGreaterThanOrEqual(8);

  const labelTip = first.getByTestId('builder-optional').getByTestId('infotip').nth(1);
  await labelTip.focus();
  await expect(page.getByRole('tooltip')).toContainText('Participants never see it');
  await page.keyboard.press('Escape');

  const remove = page.getByTestId('builder-question').nth(1).getByRole('button', { name: 'Remove question 2' });
  await remove.focus();
  await expect(page.locator('[style*="position: fixed"]').filter({ hasText: 'Remove question 2' })).toBeVisible();
  await expect(remove).not.toHaveAttribute('aria-describedby', /./);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'DE' }).click();
  await page.keyboard.press('Tab');
  await first.getByTestId('builder-optional').getByTestId('infotip').nth(1).focus();
  await expect(page.getByRole('tooltip')).toContainText('Teilnehmende sehen ihn nie');
});
