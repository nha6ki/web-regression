import { test, expect, type BrowserContext, type APIRequestContext } from '@playwright/test';

type Variant = { id: number; price: number; available: boolean; option1: string };
type CartItem = { variant_id: number; key: string; quantity: number; final_line_price: number };
type Cart = { items: CartItem[]; item_count: number; total_price: number };
let root: string;
let state: Awaited<ReturnType<BrowserContext['storageState']>>;
let first: Variant;
let second: Variant;

async function readStorefront(request: APIRequestContext, path: string) {
  const deadline = Date.now() + 30_000;
  for (let attempt = 0; ; attempt++) {
    const response = await request.get(root + path);
    if (response.status() !== 429 || attempt === 3) return response;

    const retryAfter = response.headers()['retry-after']?.trim();
    let delay = 2000 * 2 ** attempt;
    if (retryAfter) {
      const requested = /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - Date.now();
      if (!Number.isNaN(requested)) delay = Math.max(delay, requested);
    }
    if (Date.now() + delay >= deadline) return response;
    await response.dispose();
    console.log('HTTP 429 on GET ' + path + ', retrying in ' + delay + ' ms');
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

async function cart(request: APIRequestContext): Promise<Cart> {
  const response = await readStorefront(request, 'cart.js');
  expect(response.status()).toBe(200);
  return response.json();
}

async function change(request: APIRequestContext, path: string, data: object) {
  const response = await request.post(root + 'cart/' + path + '.js', { data });
  expect(response.status(), path + ' cart item').toBe(200);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240000);
  const store = process.env.SHOPIFY_QA_STORE || '';
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store)) throw new Error('Set SHOPIFY_QA_STORE to the dev store hostname.');
  const origin = 'https://' + store;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(origin);
    console.log('Open the storefront in the Edge window. Enter the storefront password there if prompted.');
    await page.waitForFunction(host => location.origin === host &&
      !location.pathname.startsWith('/password') &&
      !document.querySelector('form[action*="/password"] input[type="password"]') &&
      Boolean((window as any).Shopify?.routes?.root), origin, { timeout: 180000 });
    const routes = await page.evaluate(() => (window as any).Shopify.routes.root as string);
    const url = new URL(routes, origin);
    if (url.origin !== origin) throw new Error('Unexpected storefront origin.');
    root = url.href.replace(/\/?$/, '/');
    const product = await readStorefront(context.request, 'products/qa-notebook.js');
    expect(product.status(), 'GET products/qa-notebook.js').toBe(200);
    const variants: Variant[] = (await product.json()).variants;
    expect(variants, 'The fixture needs exactly two variants').toHaveLength(2);
    const red = variants.find(v => v.option1 === 'Red');
    const blue = variants.find(v => v.option1 === 'Blue');
    if (!red || !blue) throw new Error('Expected option values Red and Blue.');
    first = red;
    second = blue;
    for (const variant of variants) {
      expect(variant.available).toBe(true);
      expect(variant.price).toBeGreaterThan(0);
    }
    expect((await cart(context.request)).item_count, 'Start with an empty cart').toBe(0);
    // Reuse only storefront access. Each test must get its own server-side cart.
    const initial = await context.storageState();
    state = { cookies: initial.cookies.filter(c => !/^cart(?:$|_)/i.test(c.name)), origins: [] };
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(state.cookies);
  expect((await cart(context.request)).item_count).toBe(0);
});

test('選んだバリエーションがカート画面と保存明細に表示される', async ({ page }) => {
  await change(page.request, 'add', { items: [{ id: second.id, quantity: 1 }] });
  const saved = await cart(page.request);
  expect(saved.items).toHaveLength(1);
  expect(saved.items[0]).toMatchObject({ variant_id: second.id, quantity: 1 });
  await page.goto(root + 'cart');
  const productLink = page.locator('a[href*="/products/qa-notebook"]').filter({ visible: true });
  await expect(productLink.first()).toBeVisible();
  await expect(page.getByText('Blue', { exact: false }).filter({ visible: true }).first()).toBeVisible();
});

test('数量変更後の明細金額とカート合計が単価の2倍になる', async ({ page }) => {
  await change(page.request, 'add', { items: [{ id: first.id, quantity: 1 }] });
  const before = await cart(page.request);
  expect(before.items).toHaveLength(1);
  await change(page.request, 'change', { id: before.items[0].key, quantity: 2 });
  const saved = await cart(page.request);
  expect(saved.items).toHaveLength(1);
  expect(saved.items[0]).toMatchObject({ variant_id: first.id, quantity: 2, final_line_price: first.price * 2 });
  expect(saved.total_price).toBe(first.price * 2);
});

test('一方の色を削除しても他方の数量が維持される', async ({ page }) => {
  await change(page.request, 'add', { items: [{ id: first.id, quantity: 2 }, { id: second.id, quantity: 1 }] });
  const before = await cart(page.request);
  expect(before.items).toHaveLength(2);
  const selected = before.items.find(item => item.variant_id === second.id);
  expect(selected).toBeDefined();
  await change(page.request, 'change', { id: selected!.key, quantity: 0 });
  const saved = await cart(page.request);
  expect(saved.items).toHaveLength(1);
  expect(saved.items[0]).toMatchObject({ variant_id: first.id, quantity: 2 });
});

test('モバイル幅の商品ページから青を追加すると選んだ明細が保存される', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(root + 'products/qa-notebook?variant=' + second.id);
  const form = page.locator('form[action*="/cart/add"]').filter({
    has: page.locator('input[name="id"][value="' + second.id + '"]'),
  });
  const button = form.locator('button[type="submit"], input[type="submit"]').filter({ visible: true }).first();
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(async () => (await cart(page.request)).items, { timeout: 40_000, intervals: [1000, 2000] }).toMatchObject([
    { variant_id: second.id, quantity: 1, final_line_price: second.price },
  ]);
  await page.goto(root + 'cart');
  await expect(page.locator('a[href*="/products/qa-notebook"]').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(/Blue/).filter({ visible: true }).first()).toBeVisible();
});

test('赤を別々に2回追加すると同じ明細に集約される', async ({ page }) => {
  for (let added = 1; added <= 2; added++) {
    await change(page.request, 'add', { items: [{ id: first.id, quantity: 1 }] });
    const saved = await cart(page.request);
    expect(saved.items).toMatchObject([
      { variant_id: first.id, quantity: added, final_line_price: first.price * added },
    ]);
    expect(saved.total_price).toBe(first.price * added);
  }
});

test('同じ買い物セッションの別タブでカートの商品と数量を引き継ぐ', async ({ page, context }) => {
  await change(page.request, 'add', { items: [{ id: second.id, quantity: 1 }] });
  await page.goto(root + 'products/qa-notebook');
  const tab = await context.newPage();
  await tab.goto(root + 'cart');
  await tab.reload();
  await expect(tab.locator('a[href*="/products/qa-notebook"]').filter({ visible: true }).first()).toBeVisible();
  await expect(tab.getByText(/Blue/).filter({ visible: true }).first()).toBeVisible();
  const saved = await cart(tab.request);
  expect(saved.items).toMatchObject([{ variant_id: second.id, quantity: 1 }]);
  expect(saved.total_price).toBe(second.price);
});
