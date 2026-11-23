import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './vikunja-session';

type Session = { request: APIRequestContext; headers: Record<string, string> };

async function createProject({ request, headers }: Session, title: string) {
  const res = await request.put('/api/v1/projects', { headers, data: { title } });
  await expect(res).toBeOK();
  const { id } = await res.json();
  expect(id).toBeGreaterThan(0);
  return Number(id);
}

async function seedTask({ request, headers }: Session, project: number, title: string) {
  const res = await request.put('/api/v1/projects/' + project + '/tasks', { headers, data: { title } });
  await expect(res).toBeOK();
  const task = await res.json();
  expect(task).toMatchObject({ title, project_id: project, done: false });
  expect(task.id).toBeGreaterThan(0);
  return Number(task.id);
}

async function readTask({ request, headers }: Session, id: number) {
  const res = await request.get('/api/v1/tasks/' + id, { headers });
  await expect(res).toBeOK();
  return res.json();
}

async function completeFromProject(page: Page, project: number, title: string, id: number) {
  await page.goto('/projects/' + project);
  await page.getByText(title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/tasks/' + id + '/?(?:[?#].*)?$'));
  const [updated] = await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/v1/tasks/' + id),
    page.getByRole('button', { name: 'Mark task done!', exact: true }).click(),
  ]);
  expect(updated.ok()).toBe(true);
}

test('完了にしたタスクが再読み込み後も画面とAPIで完了している', async ({ page, request, headers }) => {
  const session = { request, headers };
  const project = await createProject(session, '月次報告');
  const title = '原稿を確認';
  const id = await seedTask(session, project, title);
  await completeFromProject(page, project, title, id);
  // The detail page can display completed tasks even if the list hides them.
  await page.goto('/tasks/' + id);
  await page.reload();
  await expect(page.getByRole('button', { name: /^(?:mark (?:task )?(?:as )?(?:undone|incomplete|not done)|reopen(?: task)?)[!.]?$/i })).toBeVisible();
  expect(await readTask(session, id)).toMatchObject({ id, project_id: project, title, done: true });
});

test('空の件名を送信してもプロジェクトのタスクID一覧が変わらない', async ({ page, request, headers }) => {
  const session = { request, headers };
  const project = await createProject(session, '入力検査');
  const title = '既存のタスク';
  const existing = await seedTask(session, project, title);
  const projectIds = async () => {
    // Each test owns a fresh account with only one seeded task.
    const res = await request.get('/api/v1/tasks/all', { headers, params: { per_page: 100 } });
    await expect(res).toBeOK();
    const tasks: { id: number; project_id: number }[] = await res.json();
    return tasks.filter(t => t.project_id === project).map(t => t.id).sort((a, b) => a - b);
  };
  const before = await projectIds();
  expect(before).toEqual([existing]);
  await page.goto('/projects/' + project);
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  const entry = page.locator('textarea:visible, input[placeholder*="add a task" i]:visible');
  await entry.fill('');
  await expect(entry).toHaveValue('');
  await entry.press('Enter');
  await page.waitForLoadState('networkidle');
  expect(await projectIds()).toEqual(before);
});

test('別プロジェクトの同名タスクのうち操作した1件だけが完了する', async ({ page, request, headers }) => {
  const session = { request, headers };
  const a = await createProject(session, '第一編集部');
  const b = await createProject(session, '第二編集部');
  const title = '校正を確認';
  const first = await seedTask(session, a, title);
  const second = await seedTask(session, b, title);
  expect(first).not.toBe(second);
  await completeFromProject(page, b, title, second);
  expect(await readTask(session, second)).toMatchObject({ id: second, project_id: b, title, done: true });
  expect(await readTask(session, first)).toMatchObject({ id: first, project_id: a, title, done: false });
});
