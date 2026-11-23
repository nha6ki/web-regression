import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { enterPassword, runPassword } from './support/password';

const route = (path: string) => '/?rest_route=/wc/store/v1/' + path;

async function product(api: APIRequestContext, sku: string) {
  const response = await api.get(route('products'), { params: { sku } });
  expect(response.status()).toBe(200);
  const matches = (await response.json()).filter((item: { sku: string }) => item.sku === sku);
  expect(matches).toHaveLength(1);
  return Number(matches[0].id);
}

async function cart(api: APIRequestContext) {
  const response = await api.get(route('cart'));
  expect(response.status()).toBe(200);
  const token = response.headers()['cart-token'];
  if (!token) throw new Error('Store API did not issue a cart token');
  return async (action: string, data: object) => {
    const res = await api.post(route(action), { headers: { 'Cart-Token': token }, data });
    if (!res.ok()) {
      const error = await res.json();
      throw new Error(action + ': ' + res.status() + ' ' + error.code + ' ' + error.message);
    }
    return res.json();
  };
}

async function savedOrder(page: Page, id: number) {
  await page.goto('/wp-login.php');
  await page.locator('#user_login').fill('qaadmin');
  await enterPassword(page.locator('#user_pass'), runPassword());
  await page.locator('#wp-submit').click();
  await expect(page).toHaveURL(/wp-admin/);
  const nonce = await page.request.get('/wp-admin/admin-ajax.php?action=rest-nonce');
  expect(nonce.status()).toBe(200);
  const res = await page.request.get('/?rest_route=/wc/v3/orders/' + id, {
    headers: { 'X-WP-Nonce': (await nonce.text()).trim() },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

test('カートの数量を変更すると明細小計と合計が一致する', async ({ page }) => {
  const id = await product(page.request, 'proof-paper');
  await page.goto('/?add-to-cart=' + id);
  await page.goto('/?pagename=qa-cart');
  const line = page.locator('tr.cart_item').filter({ hasText: '校正用紙' });
  await expect(line.locator('input.qty')).toHaveValue('1');
  await line.locator('input.qty').fill('2');
  await page.locator('[name=update_cart]').click();
  await expect(line.locator('.product-subtotal')).toContainText(/2,?400/);
  const res = await page.request.get(route('cart'));
  expect(res.status()).toBe(200);
  const saved = await res.json();
  expect(saved.items).toHaveLength(1);
  expect(saved.items[0]).toMatchObject({ id, quantity: 2, totals: { line_subtotal: '2400' } });
  expect(saved.totals).toMatchObject({ currency_code: 'JPY', currency_minor_unit: 0, total_price: '2400' });
});

test('注文した商品・数量・金額が店舗の注文記録と一致する', async ({ request, page }) => {
  const id = await product(request, 'proof-paper');
  const post = await cart(request);
  const basket = await post('cart/add-item', { id, quantity: 2 });
  const address = { first_name: 'QA', last_name: 'Buyer', address_1: '1 Test Street',
    city: 'Chiyoda', state: 'JP13', postcode: '1000001', country: 'JP',
    email: 'buyer@example.test', phone: '0312345678' };
  const receipt = await post('checkout', { billing_address: address, payment_method: 'bacs' });
  expect(receipt.order_id).toBeGreaterThan(0);
  const saved = await savedOrder(page, receipt.order_id);
  expect(saved).toMatchObject({ id: receipt.order_id, currency: 'JPY', payment_method: 'bacs' });
  expect(saved.line_items).toHaveLength(1);
  expect(saved.line_items[0]).toMatchObject({ product_id: id, quantity: 2 });
  expect(Number(saved.total)).toBe(Number(basket.totals.total_price));
  expect(Number(saved.total)).toBe(2400);
});

test('商品限定クーポンは対象商品の明細にだけ適用される', async ({ request }) => {
  const eligible = await product(request, 'proof-paper');
  const other = await product(request, 'envelope');
  const post = await cart(request);
  await post('cart/add-item', { id: eligible, quantity: 1 });
  await post('cart/add-item', { id: other, quantity: 1 });
  const updated = await post('cart/apply-coupon', { code: 'proof-only' });
  expect(updated.items).toHaveLength(2);
  expect(updated.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: eligible, totals: expect.objectContaining({ line_total: '1000' }) }),
    expect.objectContaining({ id: other, totals: expect.objectContaining({ line_total: '300' }) }),
  ]));
  expect(updated.totals.total_price).toBe('1300');
});
