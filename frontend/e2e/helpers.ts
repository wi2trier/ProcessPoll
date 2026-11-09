import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

export interface Created {
  code: string;
  adminKey: string;
  displayKey: string;
  questionIds: string[];
}

export interface TraceCfg {
  mode?: 'free' | 'select_sort';
  allow_repeats?: boolean;
  allow_skip?: boolean;
  min_steps?: number;
  max_steps?: number;
  activities?: string[];
  allow_custom?: boolean;
  suggest_existing?: boolean;
  max_label_length?: number;
}

export const traceConfig = (c: TraceCfg = {}) => ({
  mode: 'free',
  allow_repeats: true,
  allow_skip: true,
  min_steps: 2,
  max_steps: 30,
  activities: [],
  allow_custom: false,
  suggest_existing: true,
  max_label_length: 80,
  ...c,
});

export const traceQuestion = (c: TraceCfg = {}, prompt = 'What is your typical morning routine?', label: string | null = null) => ({
  type: 'trace',
  prompt,
  label,
  help: null,
  required: true,
  config: traceConfig(c),
});

export const roleQuestion = (prompt = 'Role', label: string | null = null) => ({
  type: 'single_choice',
  prompt,
  label,
  help: null,
  required: false,
  config: { options: ['Student', 'Lecturer'] },
});

export async function createSession(
  request: APIRequestContext,
  opts: { questions: unknown[]; settings?: Record<string, unknown>; open?: boolean; title?: string; description?: string | null },
): Promise<Created> {
  const res = await request.post('/api/v1/sessions', {
    data: { title: opts.title ?? 'E2E poll', description: opts.description ?? null, questions: opts.questions, settings: opts.settings ?? {} },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  const created: Created = {
    code: body.code,
    adminKey: body.admin_key,
    displayKey: body.display_key,
    questionIds: body.session.questions.map((q: { id: string }) => q.id),
  };
  if (opts.open ?? true) await setStatus(request, created, 'open');
  return created;
}

export async function setStatus(request: APIRequestContext, s: Created, status: string) {
  const res = await request.patch(`/api/v1/sessions/${s.code}`, { headers: { 'X-Admin-Key': s.adminKey }, data: { status } });
  expect(res.status(), await res.text()).toBe(200);
}

export async function submitViaApi(
  request: APIRequestContext,
  s: Created,
  steps: string[],
  extra: { question_id: string; value: unknown }[] = [],
) {
  const join = await request.post(`/api/v1/sessions/${s.code}/join`, { data: {} });
  expect(join.ok()).toBeTruthy();
  const { participant_token } = await join.json();
  const res = await request.post(`/api/v1/sessions/${s.code}/responses`, {
    headers: { 'X-Participant-Token': participant_token, 'Idempotency-Key': crypto.randomUUID() },
    data: { answers: [{ question_id: s.questionIds[0], value: { steps } }, ...extra] },
  });
  expect(res.status(), await res.text()).toBe(201);
}

export const MOBILE = { viewport: { width: 375, height: 812 }, locale: 'en-US', isMobile: true, hasTouch: true } as const;

export async function openParticipant(browser: Browser, code: string): Promise<Page> {
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  await page.goto(`/p/${code}`);
  return page;
}

export async function newParticipant(browser: Browser, code: string): Promise<Page> {
  const page = await openParticipant(browser, code);
  await expect(page.getByTestId('trace-input')).toBeVisible();
  return page;
}

export async function addStep(page: Page, label: string) {
  await page.getByTestId('trace-input').fill(label);
  await page.getByTestId('trace-input').press('Enter');
}

export const stepTexts = (page: Page) =>
  page.getByTestId('trace-item').locator('span.break-words').evaluateAll((els) => els.map((e) => (e.childNodes[0]?.textContent ?? '').trim()));

export function dashboardUrl(s: Created) {
  return `/host/${s.code}?key=${encodeURIComponent(s.adminKey)}`;
}

export async function openHostMenu(page: Page) {
  await page.getByTestId('host-menu').click();
  await expect(page.getByRole('menu')).toBeVisible();
}

export async function finishWizard(page: Page, nextClicks: number) {
  for (let i = 0; i < nextClicks; i++) await page.getByTestId('wizard-next').click();
  await page.getByTestId('trace-submit').click();
}

export async function noHorizontalScroll(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, `scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw);
}
