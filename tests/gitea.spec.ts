import { runPassword } from './support/password';
import { signIn } from './support/gitea';
import { test, expect } from '@playwright/test';
test('日本語Issueを画面で作成し、APIで件名と本文を検証', async ({
  page,
  playwright,
}) => {
  const owner = 'qaoperator';
  const password = runPassword();
  const api = await playwright.request.newContext({
    baseURL: 'http://gitea:3000/api/v1/',
    extraHTTPHeaders: {
      Authorization:
        'Basic ' + Buffer.from(owner + ':' + password).toString('base64'),
    },
  });
  try {
    const created = await api.post('user/repos', {
      data: { name: 'qa-demo', private: true, auto_init: true },
    });
    expect(created.status()).toBe(201);
    await signIn(page, owner, password);
    const issueFormPath = '/' + owner + '/qa-demo/issues/new';
    const formResponse = await page.goto(issueFormPath, {
      waitUntil: 'domcontentloaded',
    });
    console.log(
      'Issue form:',
      formResponse?.status(),
      new URL(page.url()).pathname,
    );
    expect(new URL(page.url()).pathname).toBe(issueFormPath);
    expect(formResponse?.status()).toBe(200);
    const title = '月次報告を確認';
    const body = '資料レビューの結果を記録する。';
    await page.locator('input[name=title]').fill(title);
    await page.locator('textarea[name=content]').fill(body);
    await page
      .locator('form')
      .filter({ has: page.locator('input[name=title]') })
      .getByRole('button', {
        name: /create issue|submit new issue|新しいイシュー|イシューを作成/i,
      })
      .click();
    await expect(page).toHaveURL(/\/issues\/\d+\/?$/);
    const number = new URL(page.url()).pathname
      .split('/')
      .filter(Boolean)
      .pop();
    const result = await api.get(
      'repos/' + owner + '/qa-demo/issues/' + number,
    );
    expect(result.status()).toBe(200);
    expect(await result.json()).toMatchObject({ title, body, state: 'open' });
  } finally {
    await api.dispose();
  }
});
