import { randomUUID } from 'node:crypto';
import { expect, test as base, type APIRequestContext } from '@playwright/test';
import { enterPassword, runPassword } from './support/password';

const user = 'qaoperator';
const files = '/remote.php/dav/files/' + user;
const trash = '/remote.php/dav/trashbin/' + user;
const filename = '月次報告.txt';
const leaf = encodeURIComponent(filename);

const test = base.extend<{ dav: APIRequestContext; folder: string }>({
  dav: async ({ playwright, baseURL }, use) => {
    const api = await playwright.request.newContext({
      baseURL, httpCredentials: { username: user, password: runPassword(), send: 'always' },
    });
    try { await use(api); } finally { await api.dispose(); }
  },
  folder: async ({ dav }, use) => {
    const folder = files + '/qa-' + randomUUID();
    await mkdir(dav, folder);
    await use(folder);
  },
});

async function mkdir(dav: APIRequestContext, path: string) {
  expect((await dav.fetch(path, { method: 'MKCOL' })).status()).toBe(201);
}

async function readFile(dav: APIRequestContext, path: string) {
  const response = await dav.get(path);
  expect(response.status()).toBe(200);
  return response.body();
}

test('日本語名のファイルを移動し、保存先と内容を確認する', async ({ dav, folder, page, baseURL }) => {
  const original = Buffer.from('月次報告：確認済み。\n');
  const source = folder + '/' + leaf;
  const target = folder + '/archive/' + leaf;
  await mkdir(dav, folder + '/archive');
  expect((await dav.put(source, { data: original })).status()).toBe(201);
  const moved = await dav.fetch(source, { method: 'MOVE', headers: { Destination: new URL(target, baseURL).href } });
  expect(moved.status()).toBe(201);
  expect((await dav.get(source)).status()).toBe(404);
  expect(await readFile(dav, target)).toEqual(original);

  await page.goto('/login');
  await page.locator('input[autocomplete="username"], input[name="user"]').first().fill(user);
  await enterPassword(page.locator('input[type=password]'), runPassword());
  await page.locator('input[type=password]').press('Enter');
  await expect(page).not.toHaveURL(/\/login(?:[/?#]|$)/, { timeout: 20000 });
  const props = await dav.fetch(folder + '/archive', {
    method: 'PROPFIND', headers: { Depth: '0', 'Content-Type': 'application/xml' },
    data: '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>',
  });
  expect(props.status()).toBe(207);
  const folderId = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return doc.getElementsByTagNameNS('http://owncloud.org/ns', 'fileid')[0]?.textContent?.trim();
  }, await props.text());
  expect(folderId).toMatch(/^\d+$/);
  await page.goto('/index.php/f/' + folderId);
  // Files may render the basename and extension in separate elements.
  const entry = page.locator('[data-cy-files-list-row-name="月次報告.txt"]:visible')
    .or(page.getByRole('link', { name: /月次報告\s*\.txt/ }).filter({ visible: true }))
    .or(page.getByText(/^月次報告\s*\.txt$/).filter({ visible: true }));
  await expect(entry.first(), 'Moved file should appear in the destination folder').toBeVisible({ timeout: 20000 });
});

test('ごみ箱から復元すると元のパスで同じ内容を取得できる', async ({ dav, folder, page, baseURL }) => {
  const content = Buffer.from('復元する原本。\n');
  const path = folder + '/' + leaf;
  expect((await dav.put(path, { data: content })).status()).toBe(201);
  expect((await dav.delete(path)).status()).toBe(204);
  expect((await dav.get(path)).status()).toBe(404);
  const list = await dav.fetch(trash + '/trash', {
    method: 'PROPFIND', headers: { Depth: '1', 'Content-Type': 'application/xml' },
    data: '<d:propfind xmlns:d="DAV:" xmlns:n="http://nextcloud.org/ns"><d:prop><n:trashbin-original-location/></d:prop></d:propfind>',
  });
  expect(list.status()).toBe(207);
  const hrefs = await page.evaluate(({ xml, location }) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.from(doc.getElementsByTagNameNS('DAV:', 'response')).filter(entry => {
      const original = entry.getElementsByTagNameNS('http://nextcloud.org/ns', 'trashbin-original-location')[0]?.textContent;
      return original?.replace(/^\/+/, '') === location;
    }).map(entry => entry.getElementsByTagNameNS('DAV:', 'href')[0].textContent!);
  }, { xml: await list.text(), location: folder.slice(files.length + 1) + '/' + filename });
  expect(hrefs).toHaveLength(1);
  const trashPath = new URL(hrefs[0], baseURL).pathname;
  const entryName = trashPath.slice(trashPath.lastIndexOf('/') + 1);
  expect(entryName).not.toBe('');
  const restored = await dav.fetch(trashPath, {
    method: 'MOVE', headers: { Destination: new URL(trash + '/restore/' + entryName, baseURL).href },
  });
  if (![201, 204].includes(restored.status())) {
    const message = await page.evaluate(xml => {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      return doc.getElementsByTagNameNS('*', 'message')[0]?.textContent || 'No DAV error message';
    }, await restored.text());
    throw new Error('Trash restore returned HTTP ' + restored.status() + ': ' + message);
  }
  expect(await readFile(dav, path)).toEqual(content);
});

test('別フォルダの同名ファイルを個別に更新できる', async ({ dav, folder }) => {
  await mkdir(dav, folder + '/a');
  await mkdir(dav, folder + '/b');
  const first = folder + '/a/' + leaf;
  const second = folder + '/b/' + leaf;
  const a = Buffer.from('第一編集部の原本。');
  const b = Buffer.from('第二編集部の原本。');
  const edited = Buffer.from('第二編集部の訂正版。');
  expect((await dav.put(first, { data: a })).status()).toBe(201);
  expect((await dav.put(second, { data: b })).status()).toBe(201);
  expect(await readFile(dav, second)).toEqual(b);
  expect((await dav.put(second, { data: edited })).status()).toBe(204);
  expect(await readFile(dav, first)).toEqual(a);
  expect(await readFile(dav, second)).toEqual(edited);
});
