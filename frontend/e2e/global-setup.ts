import { execSync } from 'node:child_process';

export default function globalSetup() {
  if (process.env.PLAYWRIGHT_BASE_URL || process.env.E2E_SKIP_BUILD) return;
  execSync('npm run build', { stdio: 'inherit' });
}
