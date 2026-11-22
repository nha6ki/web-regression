import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

test('日本語タスクを画面で作成し、APIで同じタスクの件名と所属先を確認', async ({ page, request }) => {
  const username = 'qa' + randomUUID().replaceAll('-', '').slice(0, 12);
  const password = process.env.QA_PASSWORD!;
  const title = '月次報告の資料を確認';

  const registration = await request.post('/api/v1/register', {
    data: { username, password, email: username + '@example.org' },
  });
  await expect(registration).toBeOK();

  await page.goto('/login');
  await page.locator('input[autocomplete="username"], input#username, input[name="username"]').fill(username);
  const passwordField = page.locator('input[type="password"]');
  await passwordField.fill(password);
  const [login] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/login' && r.request().method() === 'POST'),
    passwordField.press('Enter'),
  ]);
  expect(login.ok()).toBe(true);
  const { token } = await login.json();
  expect(typeof token).toBe('string');
  await page.waitForURL(url => url.pathname !== '/login');
  const headers = { Authorization: 'Bearer ' + token };
  const project = await request.put('/api/v1/projects', { headers, data: { title: '回帰テスト' } });
  await expect(project).toBeOK();
  const { id: projectId } = await project.json();
  expect(projectId).toBeGreaterThan(0);

  await page.goto('/projects/' + projectId);
  const entry = page.locator('textarea:visible, input[placeholder*="add a task" i]:visible');
  await entry.fill(title);
  const createPath = '/api/v1/projects/' + projectId + '/tasks';
  const [created] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === createPath && r.request().method() === 'PUT'),
    entry.press('Enter'),
  ]);
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  expect(id).toBeGreaterThan(0);
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  const saved = await request.get('/api/v1/tasks/' + id, { headers });
  await expect(saved).toBeOK();
  expect(await saved.json()).toMatchObject({ id, title, project_id: projectId, done: false });
});
