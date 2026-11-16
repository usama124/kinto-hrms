import { defineConfig, devices } from '@playwright/test'

// Real-browser tests against a RUNNING production build (default http://127.0.0.1:3100). Uses the demo accounts.
export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  globalSetup: './reset-mfa.ts',
  globalTeardown: './reset-mfa.ts',
  workers: 1, // one login limiter per IP; keep the traffic polite
  reporter: [['list']],
  use: { baseURL: process.env.UI_BASE ?? 'http://127.0.0.1:3100', screenshot: 'only-on-failure', trace: 'off' },
  outputDir: '/tmp/hrms-ui-results',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
