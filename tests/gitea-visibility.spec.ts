import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('同じ非公開Issueの閲覧権限をUIとAPIで確認', async ({ browser, playwright }) => {
  const baseURL = 'http://gitea:3000';
  const password = process.env.QA_PASSWORD!;
  const repo = 'qa-visibility';
  const root = '/api/v1/repos/qaoperator/' + repo;
  const title = '限定公開の議事録-' + randomUUID();
  const body = 'テスト専用本文-' + randomUUID();
  const apiFor = (user: string) => playwright.request.newContext({
    baseURL, extraHTTPHeaders: {
      Authorization: 'Basic ' + Buffer.from(user + ':' + password).toString('base64')
    }
  });
  const owner = await apiFor('qaoperator');
  let number: number;
  try {
    const created = await owner.post('/api/v1/user/repos', {data: {name:repo, private:true, auto_init:true}});
    expect(created.status()).toBe(201);
    expect((await created.json()).private).toBe(true);
    const grant = await owner.put(root + '/collaborators/qareader', {data:{permission:'read'}});
    expect(grant.ok(), 'grant read access').toBeTruthy();
    const issue = await owner.post(root + '/issues', {data:{title, body}});
    expect(issue.status()).toBe(201);
    number = (await issue.json()).number;
    expect(number).toBeGreaterThan(0);
  } finally { await owner.dispose(); }

  for (const [user, allowed] of [['qareader',true], ['qaoutsider',false]] as const) {
    await test.step(user + ' のAPI閲覧', async () => {
      const api = await apiFor(user);
      try {
        const identity = await api.get('/api/v1/user');
        expect(identity.status()).toBe(200);
        expect((await identity.json()).login).toBe(user);
        const result = await api.get(root + '/issues/' + number);
        if (allowed) {
          expect(result.status()).toBe(200);
          expect(await result.json()).toMatchObject({number,title,body});
        } else {
          expect([403,404]).toContain(result.status());
          const response = await result.text();
          expect(response).not.toContain(title);
          expect(response).not.toContain(body);
        }
      } finally { await api.dispose(); }
    });
    await test.step(user + ' のブラウザ閲覧', async () => {
      const context = await browser.newContext({baseURL});
      try {
        const page = await context.newPage();
        await page.goto('/user/login');
        await page.locator('input[name=user_name]').fill(user);
        const input = page.locator('input[name=password]');
        await input.fill(password);
        await Promise.all([
          page.waitForURL(url => url.pathname !== '/user/login'),
          input.evaluate(el => (el as HTMLInputElement).form!.requestSubmit())
        ]);
        const settings = await page.goto('/user/settings');
        expect(settings?.status()).toBe(200);
        expect(new URL(page.url()).pathname).toMatch(/^\/user\/settings(?:\/|$)/);
        const path = '/qaoperator/' + repo + '/issues/' + number;
        const result = await page.goto(path);
        if (allowed) {
          expect(result?.status()).toBe(200);
          await expect(page.locator('body')).toContainText(title);
          await expect(page.locator('body')).toContainText(body);
        } else {
          expect([403,404]).toContain(result?.status());
          await expect(page.locator('body')).not.toContainText(title);
          await expect(page.locator('body')).not.toContainText(body);
        }
      } finally { await context.close(); }
    });
  }
});
