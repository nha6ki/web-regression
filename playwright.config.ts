import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  projects: [
    {
      name: 'paperless',
      testMatch: /paperless.*\.spec\.ts$/,
      use: { baseURL: 'http://paperless:8000' },
    },
    {
      name: 'grist',
      testMatch: /grist.*\.spec\.ts$/,
      use: { baseURL: 'http://grist:8484', locale: 'en-US' },
    },
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
