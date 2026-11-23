import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPassword } from './support/password';

const test = base.extend<{ api: APIRequestContext }>({
  api: async ({ playwright, baseURL }, use) => {
    const api = await playwright.request.newContext({
      baseURL,
      httpCredentials: { username: 'qaoperator', password: runPassword(), send: 'always' },
    });
    try { await use(api); } finally { await api.dispose(); }
  },
});

function pdf(name: string) {
  return {
    name: name + '.pdf', mimeType: 'application/pdf',
    buffer: readFileSync(join(__dirname, 'fixtures', 'paperless', name + '.pdf')),
  };
}

type DocumentSummary = { id: number; title: string };

async function documents(api: APIRequestContext): Promise<DocumentSummary[]> {
  // A fresh test instance receives only the four PDFs in this suite.
  const response = await api.get('/api/documents/', { params: { page_size: 100 } });
  await expect(response).toBeOK();
  const result = await response.json();
  expect(result.next).toBeNull();
  return result.results;
}

async function waitForImport(api: APIRequestContext, before: DocumentSummary[], title: string) {
  const existing = new Set(before.map(doc => doc.id));
  let matches: DocumentSummary[] = [];
  try {
    await expect.poll(async () => {
      const added = (await documents(api)).filter(doc => !existing.has(doc.id));
      matches = added.filter(doc => doc.title === title);
      return added.map(doc => doc.title);
    }, { timeout: 90000, intervals: [500, 1000, 2000], message: 'Newly imported document titles' })
      .toEqual([title]);
  } catch (error) {
    const response = await api.get('/api/tasks/');
    if (response.ok()) {
      const body = await response.json();
      const tasks = Array.isArray(body) ? body : body.results;
      if (Array.isArray(tasks)) {
        console.log('Paperless task diagnostics:', tasks.slice(0, 10).map(task => ({
          status: task.status, result: task.result, filename: task.task_file_name,
          document: task.related_document,
        })));
      }
    }
    throw error;
  }
  return matches[0].id;
}

async function importPdf(api: APIRequestContext, name: string, title: string) {
  const before = await documents(api);
  const response = await api.post('/api/documents/post_document/', {
    multipart: { document: pdf(name), title },
  });
  await expect(response).toBeOK();
  return waitForImport(api, before, title);
}

async function createLabel(api: APIRequestContext, kind: 'tags' | 'correspondents', name: string) {
  const response = await api.post('/api/' + kind + '/', { data: { name } });
  await expect(response).toBeOK();
  return Number((await response.json()).id);
}

test.beforeEach(() => { test.setTimeout(180000); });

test('画面からPDFを取り込み、同じ原本を取得できる', async ({ page, api }) => {
  const file = pdf('QA-Invoice');
  const before = await documents(api);
  await page.goto('/dashboard');
  const [upload] = await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/documents/post_document/'),
    page.locator('input[type=file]').first().setInputFiles(file),
  ]);
  await expect(upload.ok()).toBe(true);
  const id = await waitForImport(api, before, 'QA-Invoice');
  const saved = await api.get('/api/documents/' + id + '/');
  await expect(saved).toBeOK();
  expect(await saved.json()).toMatchObject({ id, title: 'QA-Invoice' });
  const download = await api.get('/api/documents/' + id + '/download/?original=true');
  await expect(download).toBeOK();
  expect((await download.body()).equals(file.buffer)).toBe(true);
});

test('文書の取引先とタグを更新し、再取得して照合する', async ({ api }) => {
  const id = await importPdf(api, 'QA-Classification', '印刷代の請求書');
  const tag = await createLabel(api, 'tags', '請求書');
  const correspondent = await createLabel(api, 'correspondents', 'テスト印刷');
  const path = '/api/documents/' + id + '/';
  await expect(await api.patch(path, { data: { tags: [tag], correspondent } })).toBeOK();
  const saved = await api.get(path);
  await expect(saved).toBeOK();
  expect(await saved.json()).toMatchObject({ id, title: '印刷代の請求書', tags: [tag], correspondent });
});

test('タグで絞り込むと対象文書だけが表示される', async ({ page, api }) => {
  const title = '確認対象の納品書';
  const controlTitle = '対象外の見積書';
  const id = await importPdf(api, 'QA-Delivery', title);
  const control = await importPdf(api, 'QA-Estimate', controlTitle);
  expect(control).not.toBe(id);
  const tag = await createLabel(api, 'tags', '要確認');
  await expect(await api.patch('/api/documents/' + id + '/', { data: { tags: [tag] } })).toBeOK();
  const query = '?tags__id__all=' + tag;
  const response = await api.get('/api/documents/' + query);
  await expect(response).toBeOK();
  const result = await response.json();
  expect(result.count).toBe(1);
  expect(result.results[0].id).toBe(id);
  await page.goto('/documents' + query);
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(controlTitle, { exact: true })).toHaveCount(0);
});
