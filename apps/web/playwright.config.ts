import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 4000);

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'e2e', testIgnore: /perf\.spec\.ts/ },
    { name: 'perf', testMatch: /perf\.spec\.ts/, timeout: 600_000 },
  ],
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
  },
});
