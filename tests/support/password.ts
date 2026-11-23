import { expect, type Locator } from '@playwright/test';

export function runPassword(): string {
  const value = process.env.QA_PASSWORD;
  if (!value) throw new Error('Set up the test environment with bash run.sh');
  return value;
}

export async function enterPassword(field: Locator, password: string) {
  await expect(field).toBeEditable();
  // Playwright includes fill() arguments in HTML step titles.
  await field.evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement) || element.type !== 'password') {
      throw new Error('Expected a password input');
    }
    element.focus();
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, password);
}
