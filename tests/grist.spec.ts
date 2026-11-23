import { expect, test, type Page } from '@playwright/test';

const headers = { 'X-Requested-With': 'XMLHttpRequest' };

async function createInvoice(page: Page, name: string) {
  // The UI and API share the disposable default user's session.
  await page.goto('/');
  const api = page.request;
  const spaces = await api.get('/api/orgs/docs/workspaces');
  await expect(spaces).toBeOK();
  const [workspace] = await spaces.json();
  expect(workspace?.id).toBeTruthy();
  const created = await api.post('/api/workspaces/' + workspace.id + '/docs', {
    headers, data: { name },
  });
  await expect(created).toBeOK();
  const doc = await created.json();
  const root = '/api/docs/' + doc;
  const setup = await api.post(root + '/tables', {
    headers,
    data: { tables: [{ id: 'Invoice', columns: [
      { id: 'Item', fields: { type: 'Text' } },
      { id: 'Quantity', fields: { type: 'Int' } },
      { id: 'UnitPrice', fields: { type: 'Int' } },
      { id: 'Amount', fields: { type: 'Int', isFormula: true, formula: '$Quantity * $UnitPrice' } },
    ] }] },
  });
  await expect(setup).toBeOK();
  const records = root + '/tables/Invoice/records';
  const rows = [{ Item: '校正作業', Quantity: 2, UnitPrice: 2500 },
                { Item: '組版作業', Quantity: 1, UnitPrice: 800 }];
  const inserted = await api.post(records, {
    headers, data: { records: rows.map(fields => ({ fields })) },
  });
  await expect(inserted).toBeOK();
  const [target, other] = (await inserted.json()).records;
  const readRows = async () => {
    const response = await api.get(records);
    await expect(response).toBeOK();
    return (await response.json()).records;
  };
  // The first-run tour can appear after the document becomes interactive.
  const tour = page.locator('.test-onboarding-popup');
  await page.addLocatorHandler(tour, async () => {
    await tour.locator('.test-onboarding-close').click({ timeout: 5000 });
  });
  await page.goto('/doc/' + doc);
  await page.locator('.test-docpage-label').filter({ hasText: /^Invoice$/ }).click();
  const itemCell = page.locator('.field_clip').filter({ hasText: /^校正作業$/ });
  await expect(itemCell, 'Invoice should display the seeded item').toBeVisible();
  const row = page.locator('.gridview_data_scroll .record:not(.column_names)').filter({ has: itemCell });
  await expect(row).toBeVisible();
  return { root, row, id: target.id as number, otherId: other.id as number, readRows };
}

test('数量変更後、同じ明細の金額が再計算される', async ({ page }) => {
  const { row, id, readRows } = await createInvoice(page, '請求明細・数量');
  const read = async () => (await readRows()).find((r: { id: number }) => r.id === id);
  expect(await read()).toMatchObject({ id, fields: { Quantity: 2, Amount: 5000 } });
  const quantity = row.getByText('2', { exact: true });
  await quantity.click();
  await page.keyboard.press('3');
  await page.keyboard.press('Enter');
  await expect.poll(read).toMatchObject({ id, fields: { Item: '校正作業', Quantity: 3, UnitPrice: 2500, Amount: 7500 } });
  await page.reload();
  await expect(row.getByText('3', { exact: true })).toBeVisible();
  await expect(row.getByText(/^7,?500$/)).toBeVisible();
});

test('日本語の品目名を訂正しても明細IDと金額が保たれる', async ({ page }) => {
  const { row, id, readRows } = await createInvoice(page, '請求明細・訂正');
  await row.getByText('校正作業', { exact: true }).dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('初校の確認');
  await page.keyboard.press('Enter');
  await expect.poll(readRows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id, fields: expect.objectContaining({
      Item: '初校の確認', Quantity: 2, UnitPrice: 2500, Amount: 5000,
    }) }),
  ]));
  await page.reload();
  await expect(page.getByText('初校の確認', { exact: true })).toBeVisible();
  await expect(page.getByText('校正作業', { exact: true })).toHaveCount(0);
});

test('指定した明細を削除すると別の明細だけが残る', async ({ page }) => {
  const { root, id, otherId, readRows } = await createInvoice(page, '請求明細・削除');
  const deleted = await page.request.post(root + '/apply', {
    headers, data: [['RemoveRecord', 'Invoice', id]],
  });
  await expect(deleted).toBeOK();
  expect(await readRows()).toEqual([
    expect.objectContaining({ id: otherId, fields: expect.objectContaining({
      Item: '組版作業', Quantity: 1, UnitPrice: 800, Amount: 800,
    }) }),
  ]);
  await page.reload();
  await expect(page.getByText('組版作業', { exact: true })).toBeVisible();
  await expect(page.getByText('校正作業', { exact: true })).toHaveCount(0);
});
