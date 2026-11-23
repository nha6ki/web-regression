import { enterPassword } from './password';
import { expect, type Page } from '@playwright/test';

export async function signIn(page: Page, username: string, password: string) {
  await page.goto('/user/login');
  await page.locator('input[name=user_name]').fill(username);
  const passwordField = page.locator('input[name=password]');
  await enterPassword(passwordField, password);

  // Use the input's associated form so Gitea handles its own CSRF fields.
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/user/login',
    ),
    passwordField.evaluate((input) => {
      const form = (input as HTMLInputElement).form;
      if (!form) throw new Error('Gitea password input has no login form');
      form.requestSubmit();
    }),
  ]);
  console.log('Login POST:', response.status());
  await page.waitForURL((url) => url.pathname !== '/user/login');
  expect(response.status()).toBeLessThan(400);
}
