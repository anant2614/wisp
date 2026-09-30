import { defineConfig } from '@playwright/test';
import path from 'node:path';

const FIXTURES = 'http://127.0.0.1:4010';
const APP_PORT = 3100;
const home = path.join(import.meta.dirname, '.e2e-home');
const chrome = process.env.POPPET_CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    launchOptions: { executablePath: chrome },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx tests/fixtures/server.ts',
      url: `${FIXTURES}/__test/health`,
      reuseExistingServer: false,
    },
    {
      // Run `next build` first (npm run test:e2e does).
      command: `rm -rf ${home} && npx next start -p ${APP_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${APP_PORT}/api/conversations`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        POPPET_HOME: home,
        POPPET_APP_URL: `http://127.0.0.1:${APP_PORT}`,
        POPPET_ANTHROPIC_BASE_URL: `${FIXTURES}/anthropic`,
        POPPET_ANTHROPIC_API_KEY: 'sk-fixture',
        POPPET_SECRETS: 'file',
        POPPET_SANDBOX: 'docker',
        POPPET_BROWSER_HEADLESS: '1',
        POPPET_BROWSER_PORT: '8941',
        POPPET_CHROME_PATH: chrome,
        POPPET_INBOX_POLL_MS: '300',
        GOOGLE_CLIENT_ID: 'fixture-client',
        GOOGLE_CLIENT_SECRET: 'fixture-secret',
        GOOGLE_AUTH_URL: `${FIXTURES}/google/auth`,
        GOOGLE_TOKEN_URL: `${FIXTURES}/google/token`,
        GMAIL_API_BASE: `${FIXTURES}/google`,
        DRIVE_API_BASE: `${FIXTURES}/google`,
        DRIVE_UPLOAD_BASE: `${FIXTURES}/google/upload`,
        REDDIT_CLIENT_ID: 'fixture',
        REDDIT_CLIENT_SECRET: 'fixture',
        REDDIT_AUTH_URL: `${FIXTURES}/reddit/api/v1/access_token`,
        REDDIT_API_BASE: `${FIXTURES}/reddit/api`,
        MCP_REGISTRY_URL: `${FIXTURES}/registry`,
      },
    },
  ],
});
