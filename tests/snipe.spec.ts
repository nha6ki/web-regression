import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { enterPassword, runPassword } from './support/password';

const test = base.extend<{ api: APIRequestContext }>({
  api: async ({ playwright, baseURL }, use) => {
    const token = process.env.SNIPE_TOKEN;
    if (!token) throw new Error('Start the suite with bash run.sh');
    const api = await playwright.request.newContext({
      baseURL, extraHTTPHeaders: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    try { await use(api); } finally { await api.dispose(); }
  },
});

async function post(api: APIRequestContext, path: string, data: object) {
  const res = await api.post('/api/v1/' + path, { data });
  await expect(res).toBeOK();
  const body = await res.json();
  expect(body.status, JSON.stringify(body.messages)).toBe('success');
  return body.payload;
}

async function asset(api: APIRequestContext, id: number) {
  const res = await api.get('/api/v1/hardware/' + id);
  await expect(res).toBeOK();
  const record = await res.json();
  expect(record.id).toBe(id);
  return record;
}

async function inventory(api: APIRequestContext, key: string) {
  const category = await post(api, 'categories', { name: key, category_type: 'asset' });
  const model = await post(api, 'models', { name: key + ' Laptop', category_id: category.id });
  const status = await post(api, 'statuslabels', { name: key + ' Ready', type: 'deployable' });
  const user = await post(api, 'users', {
    first_name: 'QA', last_name: key, username: 'borrower-' + key, password: runPassword(),
    password_confirmation: runPassword(),
  });
  const create = async (tag: string) => {
    const result = await post(api, 'hardware', {
      asset_tag: tag, model_id: model.id, status_id: status.id,
    });
    expect(await asset(api, result.id)).toMatchObject({ asset_tag: tag, assigned_to: null });
    return Number(result.id);
  };
  const checkout = (id: number) => post(api, 'hardware/' + id + '/checkout', {
    checkout_to_type: 'user', assigned_user: user.id, status_id: status.id,
  });
  return { create, checkout, userId: user.id, statusId: status.id, modelId: model.id };
}

test('PCを利用者に貸し出し、資産IDで貸出先を照合する', async ({ api, page }) => {
  const stock = await inventory(api, 'Checkout');
  const tag = 'QA-PC-001';
  const id = await stock.create(tag);
  await stock.checkout(id);
  expect(await asset(api, id)).toMatchObject({ asset_tag: tag, assigned_to: { id: stock.userId } });
  await page.goto('/login');
  await page.locator('input[name=username]').fill('qaoperator');
  await enterPassword(page.locator('input[name=password]'), runPassword());
  await page.locator('button[type=submit]').click();
  await expect(page).not.toHaveURL(/\/login\/?$/);
  await page.goto('/hardware/' + id);
  await expect(page.locator('body')).toContainText(tag);
});

test('返却後、同じ資産の貸出先が解除される', async ({ api }) => {
  const stock = await inventory(api, 'Checkin');
  const id = await stock.create('QA-PC-002');
  await stock.checkout(id);
  expect((await asset(api, id)).assigned_to.id).toBe(stock.userId);
  await post(api, 'hardware/' + id + '/checkin', { status_id: stock.statusId });
  expect(await asset(api, id)).toMatchObject({ asset_tag: 'QA-PC-002', assigned_to: null });
});

test('同型PCを2台用意し、選んだ資産だけが貸出中になる', async ({ api }) => {
  const stock = await inventory(api, 'SameModel');
  const first = await stock.create('QA-TWIN-A');
  const second = await stock.create('QA-TWIN-B');
  expect(first).not.toBe(second);
  await stock.checkout(second);
  expect(await asset(api, first)).toMatchObject({ model: { id: stock.modelId }, assigned_to: null });
  expect(await asset(api, second)).toMatchObject({
    model: { id: stock.modelId }, assigned_to: { id: stock.userId },
  });
});
