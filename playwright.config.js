import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:8087', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'node scripts/browser-server.js',
    url: 'http://127.0.0.1:8087/health',
    env: { PORT: '8087', HOST: '127.0.0.1' },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
  },
});
