import { expect } from '@playwright/test';
import { test } from './vikunja-session';

test('日本語タスクを画面で作成し、APIで同じタスクの件名と所属先を確認', async ({
  page,
  request,
  headers,
}) => {
  const title = '月次報告の資料を確認';
  const project = await request.put('/api/v1/projects', {
    headers,
    data: { title: '回帰テスト' },
  });
  await expect(project).toBeOK();
  const { id: projectId } = await project.json();
  expect(projectId).toBeGreaterThan(0);

  await page.goto('/projects/' + projectId);
  const entry = page.locator(
    'textarea:visible, input[placeholder*="add a task" i]:visible',
  );
  await entry.fill(title);
  const createPath = '/api/v1/projects/' + projectId + '/tasks';
  const [created] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === createPath &&
        r.request().method() === 'PUT',
    ),
    entry.press('Enter'),
  ]);
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  expect(id).toBeGreaterThan(0);
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  const saved = await request.get('/api/v1/tasks/' + id, { headers });
  await expect(saved).toBeOK();
  expect(await saved.json()).toMatchObject({
    id,
    title,
    project_id: projectId,
    done: false,
  });
});
