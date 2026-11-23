import { test, expect, type Page } from '@playwright/test';
import { enterPassword, runPassword } from './support/password';

function endpoint(id?: number) {
  return '/?rest_route=/wp/v2/posts' + (id === undefined ? '' : '/' + id);
}

async function editorSession(page: Page) {
  await page.goto('/wp-login.php');
  await page.locator('#user_login').fill('qaeditor');
  await enterPassword(page.locator('#user_pass'), runPassword());
  await page.locator('#wp-submit').click();
  await expect(page).toHaveURL(/\/wp-admin\//);
  const response = await page.request.get('/wp-admin/admin-ajax.php?action=rest-nonce');
  await expect(response).toBeOK();
  const nonce = (await response.text()).trim();
  expect(/^[0-9a-f]{10}$/.test(nonce)).toBe(true);
  return { 'X-WP-Nonce': nonce };
}

async function save(page: Page, headers: Record<string, string>, data: object, id?: number) {
  const response = await page.request.post(endpoint(id), { headers, data });
  await expect(response).toBeOK();
  const post = await response.json();
  expect(post.id).toBeGreaterThan(0);
  return post;
}

test('下書きは編集者が取得でき、未ログインの読者には表示されない', async ({ page, browser, baseURL }) => {
  const headers = await editorSession(page);
  const title = '校内掲示の下書き';
  const content = '配布前の時刻案を確認する。';
  const { id } = await save(page, headers, { title, content, status: 'draft' });
  const saved = await page.request.get(endpoint(id) + '&context=edit', { headers });
  await expect(saved).toBeOK();
  expect(await saved.json()).toMatchObject({ id, status: 'draft', title: { raw: title }, content: { raw: content } });
  const reader = await browser.newContext({ baseURL });
  try {
    const denied = await reader.request.get(endpoint(id));
    expect([401, 403, 404]).toContain(denied.status());
    expect(await denied.text()).not.toContain(content);
    const tab = await reader.newPage();
    expect((await tab.goto('/?p=' + id))?.status()).toBe(404);
    await expect(tab.locator('body')).not.toContainText(title);
    await expect(tab.locator('body')).not.toContainText(content);
  } finally { await reader.close(); }
});

test('下書きを一覧画面から公開すると日本語のお知らせを読める', async ({ page, browser, baseURL }) => {
  const headers = await editorSession(page);
  const title = '臨時休業のお知らせ';
  const content = '水曜日の窓口を休止します。';
  const { id } = await save(page, headers, { title, content, status: 'draft' });
  await page.goto('/wp-admin/edit.php?post_status=draft');
  const row = page.locator('#post-' + id);
  await row.hover();
  await row.locator('.editinline').click();
  const form = page.locator('#edit-' + id);
  await form.locator('select[name="_status"]').selectOption('publish');
  await form.locator('button.save').click();
  await expect(form).toBeHidden();
  const reader = await browser.newContext({ baseURL });
  try {
    const published = await reader.request.get(endpoint(id));
    await expect(published).toBeOK();
    const post = await published.json();
    expect(post).toMatchObject({ id, status: 'publish', title: { rendered: title } });
    const tab = await reader.newPage();
    expect((await tab.goto(post.link))?.status()).toBe(200);
    await expect(tab.getByRole('heading', { name: title, exact: true }).first()).toBeVisible();
    await expect(tab.getByText(content, { exact: true })).toBeVisible();
  } finally { await reader.close(); }
});

test('本文を訂正しても同じ投稿URLで最新版を読める', async ({ page, browser, baseURL }) => {
  const headers = await editorSession(page);
  const original = '受付開始は午前九時です。';
  const corrected = '受付開始は午前十時です。';
  const { id, link } = await save(page, headers, { title: '受付時間の訂正', content: original, status: 'publish' });
  const reader = await browser.newContext({ baseURL });
  try {
    const tab = await reader.newPage();
    expect((await tab.goto(link))?.status()).toBe(200);
    await expect(tab.getByText(original, { exact: true })).toBeVisible();
    await save(page, headers, { content: corrected }, id);
    const res = await reader.request.get(endpoint(id));
    await expect(res).toBeOK();
    expect(await res.json()).toMatchObject({ id, link, status: 'publish' });
    expect((await tab.reload())?.status()).toBe(200);
    await expect(tab).toHaveURL(link);
    await expect(tab.getByText(corrected, { exact: true })).toBeVisible();
    await expect(tab.locator('body')).not.toContainText(original);
  } finally { await reader.close(); }
});
