import { defineConfig } from '@playwright/test';

const external = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = external ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',

      use: { browserName: 'chromium', channel: process.env.PW_CHANNEL || undefined },
    },
  ],
  webServer: external
    ? undefined
    : {
        command: 'npm run build && node ../deploy/ci/serve-dist.mjs --dist dist --port 8080',
        url: 'http://localhost:8080/',
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
