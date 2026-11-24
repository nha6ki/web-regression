import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'cart.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 60000,
  outputDir: '../../reports/shopify/test-results',
  reporter: [['list'], ['html', { outputFolder: '../../reports/shopify/html', open: 'never' }]],
  use: {
    channel: 'msedge', headless: false,
    video: process.env.SHOPIFY_QA_VIDEO === '1' ? { mode: 'on', size: { width: 390, height: 844 } } : 'off',
  },
});
