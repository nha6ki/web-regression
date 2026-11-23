import { runPassword, enterPassword } from './support/password';
import { randomUUID } from 'node:crypto';
import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ headers: Record<string, string> }>({
  headers: async ({ page, request }, use) => {
    const username = 'qa' + randomUUID().replaceAll('-', '').slice(0, 12);
    const password = runPassword();

    const registration = await request.post('/api/v1/register', {
      data: { username, password, email: username + '@example.org' },
    });
    await expect(registration).toBeOK();

    await page.goto('/login');
    await page
      .locator(
        'input[autocomplete="username"], input#username, input[name="username"]',
      )
      .fill(username);
    const passwordField = page.locator('input[type="password"]');
    await enterPassword(passwordField, password);
    const [login] = await Promise.all([
      page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/v1/login' &&
          r.request().method() === 'POST',
      ),
      passwordField.press('Enter'),
    ]);
    expect(login.ok()).toBe(true);
    const { token } = await login.json();
    expect(typeof token).toBe('string');
    await page.waitForURL((url) => url.pathname !== '/login');
    const headers = { Authorization: 'Bearer ' + token };
    await use(headers);
  },
});
