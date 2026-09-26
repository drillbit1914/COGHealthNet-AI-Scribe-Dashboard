import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
export default defineConfig({
  testDir: 'tests/e2e',
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
    env: { ...process.env, E2E: '1' } as Record<string, string>,
  },
});
