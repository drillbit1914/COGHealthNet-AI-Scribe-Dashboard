import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const MESSAGE_LOG = path.resolve('test-results/e2e-messages.jsonl');
export const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgres://wav:wav@localhost:5432/wav_e2e';
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['iPhone 13'],
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: `pnpm next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      E2E: '1',
      MESSAGING_LOG_FILE: MESSAGE_LOG,
      DATABASE_URL: E2E_DB,
      DIRECT_URL: E2E_DB,
    } as Record<string, string>,
  },
});
