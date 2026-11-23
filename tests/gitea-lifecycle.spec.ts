import { runPassword } from './support/password';
import { signIn } from './support/gitea';
import { test, expect } from '@playwright/test';
test('更新後の日本語件名で検索し、同じIssueをクローズ', async ({
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
      data: { name: 'qa-lifecycle', private: true, auto_init: true },
    });
    expect(created.status()).toBe(201);
    await signIn(page, owner, password);

    const path = '/qaoperator/qa-lifecycle/issues';
    const apiPath = 'repos' + path;
    const issue = await api.post(apiPath, { data: { title: '集計作業' } });
    expect(issue.status()).toBe(201);
    const { number } = await issue.json();
    const item = apiPath + '/' + number;
    const other = await api.post(apiPath, { data: { title: '別件の確認' } });
    expect(other.status()).toBe(201);
    const title = '月次集計の再確認';
    await test.step('APIで件名を編集', async () => {
      const edit = await api.patch(item, { data: { title } });
      expect(edit.ok()).toBeTruthy();
      expect(await edit.json()).toMatchObject({ number, title, state: 'open' });
    });
    await test.step('一覧画面で更新後の件名を検索', async () => {
      const link = page.getByRole('link', { name: title, exact: true });
      await expect(async () => {
        await page.goto(path + '?q=' + encodeURIComponent(title));
        await expect(link).toBeVisible({ timeout: 1500 });
        await expect(
          page.getByRole('link', { name: '別件の確認', exact: true }),
        ).toHaveCount(0);
      }).toPass({ timeout: 15000 });
      await link.click();
      expect(new URL(page.url()).pathname).toBe(path + '/' + number);
    });
    await test.step('APIでクローズし、再取得した状態を確認', async () => {
      const closed = await api.patch(item, { data: { state: 'closed' } });
      expect(closed.ok()).toBeTruthy();
      const stored = await api.get(item);
      expect(stored.status()).toBe(200);
      expect(await stored.json()).toMatchObject({
        number,
        title,
        state: 'closed',
      });
    });
  } finally {
    await api.dispose();
  }
});
