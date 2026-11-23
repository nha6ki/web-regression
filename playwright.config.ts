import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  projects: [
    {
      name: 'gitea',
      testMatch: /gitea.*\.spec\.ts$/,
      use: { baseURL: 'http://gitea:3000' },
    },
    {
      name: 'vikunja',
      testMatch: /vikunja.*\.spec\.ts$/,
      use: { baseURL: 'http://vikunja:3456', locale: 'en-US' },
    },
  ],
  outputDir: '/output/test-results',
  retries: 0,
  workers: 1,
  timeout: 60000,
  use: { screenshot: 'only-on-failure' },
  reporter: [
    ['list'],
    ['html', { outputFolder: '/output/html', open: 'never' }],
  ],
});
