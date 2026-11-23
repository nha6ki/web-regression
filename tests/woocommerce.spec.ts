import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { enterPassword, runPassword } from './support/password';

const route = (path: string) => '/?rest_route=/wc/store/v1/' + path;

const billingAddress = { first_name: 'QA', last_name: 'Buyer', address_1: '1 Test Street',
    city: 'Chiyoda', state: 'JP13', postcode: '1000001', country: 'JP',
    email: 'buyer@example.test', phone: '0312345678' };

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
  const receipt = await post('checkout', { billing_address: billingAddress, payment_method: 'bacs' });
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

async function openCouponCart(page: Page) {
  const id = await product(page.request, 'proof-paper');
  await page.goto('/?add-to-cart=' + id);
  await page.goto('/?pagename=qa-cart');
  await expect(page.locator('tr.cart_item input.qty')).toHaveValue('1');
  return id;
}

async function readCart(page: Page) {
  const res = await page.request.get(route('cart'));
  expect(res.status()).toBe(200);
  return res.json();
}

test('モバイル幅でクーポンを適用・解除すると画面と保存金額が元に戻る', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCouponCart(page);
  const total = page.locator('.cart_totals .order-total .amount').first();
  await expect(total).toHaveText(/1,?200/);
  await page.locator('#coupon_code').fill('proof-only');
  await page.locator('[name="apply_coupon"]').click();
  await expect(total).toHaveText(/1,?000/);
  const discounted = await readCart(page);
  expect(discounted.coupons).toMatchObject([{ code: 'proof-only' }]);
  expect(discounted.totals.total_price).toBe('1000');
  await page.locator('.woocommerce-remove-coupon[data-coupon="proof-only"]').click();
  await expect(total).toHaveText(/1,?200/);
  const restored = await readCart(page);
  expect(restored.coupons).toEqual([]);
  expect(restored.totals.total_price).toBe('1200');
});

test('無効なクーポンを入力するとエラーが表示され、商品・数量・金額が保たれる', async ({ page }) => {
  const id = await openCouponCart(page);
  const before = await readCart(page);
  expect(before.items).toMatchObject([{ id, quantity: 1 }]);
  expect(before.totals.total_price).toBe('1200');
  await page.locator('#coupon_code').fill('qa-missing-coupon');
  await page.locator('[name="apply_coupon"]').click();
  const notice = page.locator('#coupon-error-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('qa-missing-coupon');
  const after = await readCart(page);
  expect(after.items).toMatchObject([{ id, quantity: 1 }]);
  expect(after.coupons).toEqual([]);
  expect(after.totals).toEqual(before.totals);
});

test('割引後に注文すると対象明細・割引額・請求合計が同じ注文に保存される', async ({ request, page }) => {
  const paper = await product(request, 'proof-paper');
  const envelope = await product(request, 'envelope');
  const post = await cart(request);
  await post('cart/add-item', { id: paper, quantity: 1 });
  await post('cart/add-item', { id: envelope, quantity: 1 });
  const basket = await post('cart/apply-coupon', { code: 'proof-only' });
  expect(basket.totals.total_price).toBe('1300');
  const receipt = await post('checkout', { billing_address: billingAddress, payment_method: 'bacs' });
  expect(receipt.order_id).toBeGreaterThan(0);
  const order = await savedOrder(page, receipt.order_id);
  expect(order).toMatchObject({ id: receipt.order_id, currency: 'JPY', payment_method: 'bacs' });
  expect(order.coupon_lines).toMatchObject([{ code: 'proof-only' }]);
  expect(Number(order.discount_total)).toBe(200);
  expect(Number(order.total)).toBe(Number(basket.totals.total_price));
  expect(order.line_items).toHaveLength(2);
  for (const [id, expected] of [[paper, 1000], [envelope, 300]]) {
    const line = order.line_items.find((item: { product_id: number }) => item.product_id === id);
    expect(line).toMatchObject({ quantity: 1 });
    expect(Number(line.total)).toBe(expected);
  }
});

test('クーポン適用後に画面で数量を変更し、再読込後の金額と確定注文を照合する', async ({ page }, info) => {
  const paper = await openCouponCart(page);
  const envelope = await product(page.request, 'envelope');
  await page.goto('/?add-to-cart=' + envelope);
  await page.goto('/?pagename=qa-cart');

  const totals = page.locator('.cart_totals');
  const total = totals.locator('.order-total .amount');
  const discount = totals.locator('.coupon-proof-only .amount');
  const paperQty = page.locator('tr.cart_item').filter({ hasText: '校正用紙' }).locator('input.qty');
  const envelopeQty = page.locator('tr.cart_item').filter({ hasText: '封筒' }).locator('input.qty');
  // WooCommerce may display a yen symbol and thousands separator.
  const yen = (amount: number) => new RegExp('^\\s*[¥￥]?\\s*' +
    amount.toLocaleString('en-US').replace(',', ',?') + '\\s*$');
  await expect(total).toHaveText(yen(1500));
  await page.locator('#coupon_code').fill('proof-only');
  await page.locator('[name=apply_coupon]').click();
  await expect(total).toHaveText(yen(1300));
  await expect(discount).toHaveText(/^\s*[-–−]\s*[¥￥]?\s*200\s*$/);

  await paperQty.fill('2');
  await page.locator('[name=update_cart]').click();
  await expect(total).toHaveText(yen(2300));
  await page.reload();
  await expect(paperQty).toHaveValue('2');
  await expect(envelopeQty).toHaveValue('1');
  await expect(total).toHaveText(yen(2300));
  await expect(discount).toHaveText(/^\s*[-–−]\s*[¥￥]?\s*400\s*$/);
  await info.attach('cart-after-reload.png', { body: await totals.screenshot(), contentType: 'image/png' });

  const basket = await readCart(page);
  expect(basket.totals).toMatchObject({ currency_code: 'JPY', currency_minor_unit: 0, total_discount: '400', total_price: '2300' });
  expect(basket.coupons).toMatchObject([{ code: 'proof-only' }]);
  expect(basket.items).toHaveLength(2);
  for (const [id, quantity, subtotal, net] of [[paper, 2, 2400, 2000], [envelope, 1, 300, 300]]) {
    const item = basket.items.find((x: { id: number }) => x.id === id);
    expect(item).toMatchObject({ quantity, totals: { line_subtotal: String(subtotal), line_total: String(net) } });
  }

  // Use the shopper's cookies so checkout consumes the cart edited on screen.
  const post = await cart(page.request);
  const receipt = await post('checkout', { billing_address: billingAddress, payment_method: 'bacs' });
  expect(receipt.order_id).toBeGreaterThan(0);
  const order = await savedOrder(page, receipt.order_id);
  expect(order).toMatchObject({ id: receipt.order_id, currency: 'JPY', payment_method: 'bacs' });
  expect(order.coupon_lines).toMatchObject([{ code: 'proof-only' }]);
  expect(Number(order.discount_total)).toBe(Number(basket.totals.total_discount));
  expect(Number(order.total)).toBe(Number(basket.totals.total_price));
  expect(order.line_items).toHaveLength(2);
  for (const item of basket.items) {
    const line = order.line_items.find((x: { product_id: number }) => x.product_id === item.id);
    expect(line).toMatchObject({ quantity: item.quantity });
    expect(Number(line.subtotal)).toBe(Number(item.totals.line_subtotal));
    expect(Number(line.total)).toBe(Number(item.totals.line_total));
  }
  await info.attach('order-reconciliation.json', {
    contentType: 'application/json',
    body: JSON.stringify({ orderId: order.id, cartTotal: basket.totals.total_price,
      discount: order.discount_total, orderTotal: order.total, currency: order.currency,
      lines: order.line_items.map((x: { product_id: number; quantity: number; subtotal: string; total: string }) =>
        ({ productId: x.product_id, quantity: x.quantity, subtotal: x.subtotal, total: x.total })) }, null, 2),
  });

  await page.goto('/wp-admin/admin.php?page=wc-orders&action=edit&id=' + order.id);
  const panel = page.locator('#woocommerce-order-items');
  if (!await panel.count()) await page.goto('/wp-admin/post.php?action=edit&post=' + order.id);
  await expect(panel).toContainText('校正用紙');
  await expect(panel).toContainText('封筒');
  await info.attach('stored-order.png', { body: await panel.screenshot(), contentType: 'image/png' });
});
