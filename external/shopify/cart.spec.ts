import { test, expect, type BrowserContext, type Frame, type Locator, type APIRequestContext } from '@playwright/test';

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
    const password = process.env.SHOPIFY_STOREFRONT_PASSWORD;
    if (password) {
      const current = new URL(page.url());
      if (current.origin !== origin) throw new Error('Unexpected storefront origin.');
      const passwordForm = page.locator('form[action*="/password"]').filter({
        has: page.locator('input[type="password"]'),
      });
      if (current.pathname.startsWith('/password') || await passwordForm.count()) {
        // Use the same isolated, unrecorded session as the initial storefront visit.
        const response = await context.request.post(origin + '/password', {
          form: { form_type: 'storefront_password', utf8: '✓', password },
          maxRedirects: 0,
        });
        const status = response.status();
        await response.dispose();
        if (status >= 400) throw new Error('Storefront login returned HTTP ' + status);
        await page.goto(origin);
        if (new URL(page.url()).pathname.startsWith('/password') || await passwordForm.count()) {
          throw new Error('Storefront is still locked. Check the saved password or use manual login.');
        }
      }
    } else {
      console.log('Enter the storefront password in Edge if prompted.');
    }
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

test.describe('SH-01', () => {
  test.use({
    viewport: { width: 390, height: 844 },
  });

  test('商品一覧からノートを開き、赤から青に選び直して1冊だけ追加する', async ({ page }, info) => {
    await page.goto(root + 'collections/all');
    const main = page.getByRole('main');
    const card = main.locator('product-card').filter({
      has: page.locator('a[href*="/products/qa-notebook"]'),
    }).filter({ visible: true });
    await expect(card).toHaveCount(1);
    const titleLink = card.locator('a').filter({ hasText: /^\s*QA Notebook\s*$/, visible: true });
    const title = card.getByText('QA Notebook', { exact: true }).filter({ visible: true });
    const target = await titleLink.count() ? titleLink.first() : title.first();
    await target.click({ timeout: 10000 });
    await expect(page).toHaveURL(/\/products\/qa-notebook\/?(?:[?#].*)?$/);
    const form = main.locator('form[action*="/cart/add"]').filter({
      has: page.locator('[type="submit"]:visible'),
    }).first();
    const variantId = form.locator('[name="id"]');
    const picker = main.locator('variant-picker, variant-selects, variant-radios')
      .filter({ visible: true }).first();
    await expect(picker).toBeVisible();

    for (const variant of [first, second]) {
      const radio = picker.locator('input[type="radio"][value="' + variant.option1 + '"]');
      if (await radio.count()) {
        // Swatch themes often visually hide the input and render its label instead.
        const label = await radio.evaluate(input => (input as HTMLInputElement).labels?.[0]?.control?.id);
        if (label) {
          await picker.locator('label[for=' + JSON.stringify(label) + '], label:has(input[id=' +
            JSON.stringify(label) + '])').first().click();
        } else {
          await radio.check();
        }
        await expect(radio).toBeChecked();
      } else {
        const select = picker.getByRole('combobox');
        await select.selectOption({ label: variant.option1 });
        await expect(select.locator('option:checked')).toHaveText(variant.option1);
      }
      await expect(variantId).toHaveValue(String(variant.id));
    }

    const button = form.locator('[type="submit"]:visible').first();
    await expect(button).toBeEnabled();
    await picker.scrollIntoViewIfNeeded();
    await info.attach('01-blue-selected.png', { body: await page.screenshot(), contentType: 'image/png' });
    const [added] = await Promise.all([
      page.waitForResponse(res => res.request().method() === 'POST' &&
        new URL(res.url()).origin === new URL(root).origin &&
        /\/cart\/add(?:\.js)?\/?$/.test(new URL(res.url()).pathname)),
      button.click(),
    ]);
    expect(added.status(), 'Add-to-cart response').toBeLessThan(400);
    await page.goto(root + 'cart');
    const row = main.locator('tr, [role="row"], .cart-item')
      .filter({ has: page.locator('a[href*="/products/qa-notebook"]') })
      .filter({ visible: true });
    const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
      .format(second.price / 100);
    async function verifyDisplay() {
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('QA Notebook');
      await expect(row).toContainText(/\bBlue\b/);
      await expect(row.locator('input[type="number"]:visible')).toHaveValue('1');
      await expect(row).toContainText(price);
      const total = main.getByTestId('cart-total-value').filter({ visible: true });
      await expect(total).toBeVisible();
      await expect(total.getByText(price + ' USD', { exact: true })).toBeVisible();
    }
    await verifyDisplay();
    await page.reload();
    await verifyDisplay();
    const saved = await cart(page.request);
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]).toMatchObject({ variant_id: second.id, quantity: 1, final_line_price: second.price });
    expect(saved.item_count).toBe(1);
    expect(saved.total_price).toBe(second.price);
    await row.scrollIntoViewIfNeeded();
    await info.attach('02-cart-reloaded.png', { body: await page.screenshot(), contentType: 'image/png' });
    await info.attach('cart-result.json', {
      body: JSON.stringify({ variant_id: saved.items[0].variant_id, quantity: saved.items[0].quantity,
        line_price: saved.items[0].final_line_price, total_price: saved.total_price }, null, 2),
      contentType: 'application/json',
    });
  });
});

test('SH-02 赤だけを買い足し、色別の冊数と商品小計がチェックアウトに引き継がれる', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await change(page.request, 'add', { items: [
    { id: second.id, quantity: 1 }, { id: first.id, quantity: 1 },
  ] });
  await page.goto(root + 'cart');
  const main = page.getByRole('main');
  const rows = main.locator('tr, [role="row"], .cart-item')
    .filter({ has: page.locator('a[href*="/products/qa-notebook"]'), visible: true });
  const red = rows.filter({ hasText: /\bRed\b/ });
  const blue = rows.filter({ hasText: /\bBlue\b/ });
  const money = (cents: number) => '$' + (cents / 100).toFixed(2);
  const subtotal = first.price * 2 + second.price;

  async function verifyCart(redQuantity: number) {
    await expect(rows).toHaveCount(2);
    await expect(red.locator('input[type="number"]:visible')).toHaveValue(String(redQuantity));
    await expect(blue.locator('input[type="number"]:visible')).toHaveValue('1');
    const expected = money(first.price * redQuantity + second.price) + ' USD';
    await expect(main.getByTestId('cart-total-value').filter({ visible: true })
      .getByText(expected, { exact: true })).toBeVisible();
  }

  await verifyCart(1);
  await info.attach('01-before.png', { body: await main.screenshot(), contentType: 'image/png' });
  const plus = red.locator('button[name="plus"], button.quantity-plus')
    .or(red.getByRole('button', { name: /increase|increment|add one/i })).filter({ visible: true });
  await plus.click();
  await verifyCart(2);
  await page.reload();
  await verifyCart(2);
  const saved = await cart(page.request);
  expect(saved.items).toHaveLength(2);
  expect(saved.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ variant_id: first.id, quantity: 2, final_line_price: first.price * 2 }),
    expect.objectContaining({ variant_id: second.id, quantity: 1, final_line_price: second.price }),
  ]));
  expect(saved.item_count).toBe(3);
  expect(saved.total_price).toBe(subtotal);
  await info.attach('02-reloaded.png', { body: await main.screenshot(), contentType: 'image/png' });

  await main.getByRole('button', { name: /^check\s*out$/i }).click();
  await expect(page).toHaveURL(/\/checkouts?\//);
  const productRows = page.getByRole('row').filter({ hasText: 'QA Notebook', visible: true });
  const summaryButton = page.getByRole('button', { name: /order summary/i }).filter({ visible: true });
  await expect(productRows.first().or(summaryButton.first()).first()).toBeVisible();
  if (!await productRows.first().isVisible() && await summaryButton.count()) {
    await summaryButton.first().click();
  }
  await expect(productRows).toHaveCount(2);
  for (const [variant, count] of [[first, 2], [second, 1]] as const) {
    const line = productRows.filter({
      has: page.getByRole('cell', { name: 'QA Notebook ' + variant.option1, exact: true }),
    });
    await expect(line).toHaveCount(1);
    await expect(line.getByRole('cell', { name: String(count), exact: true })).toHaveCount(1);
    await expect(line.getByRole('cell', { name: money(variant.price * count), exact: true })).toBeVisible();
  }
  const subtotalRow = page.getByRole('row').filter({
    has: page.getByRole('rowheader', { name: 'Subtotal · 3 items', exact: true }),
    visible: true,
  });
  await expect(subtotalRow.getByRole('cell', { name: money(subtotal), exact: true })).toBeVisible();
  await productRows.first().scrollIntoViewIfNeeded();
  await info.attach('03-checkout.png', { body: await page.screenshot(), contentType: 'image/png' });
});

test('SH-03 購入前に青だけを削除し、赤2冊の小計をチェックアウトと照合する', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const money = (cents: number) => '$' + (cents / 100).toFixed(2);
  const redAmount = first.price * 2;
  await change(page.request, 'add', { items: [
    { id: first.id, quantity: 2 }, { id: second.id, quantity: 1 },
  ] });
  await page.goto(root + 'cart');
  const form = page.locator('#cart-form');
  const productRows = form.locator('tr').filter({
    has: page.locator('input[type="number"]:visible'),
  });
  const red = productRows.filter({ hasText: 'Red' });
  const blue = productRows.filter({ hasText: 'Blue' });
  const qty = 'input[type="number"]:visible';
  await expect(productRows).toHaveCount(2);
  await expect(red.locator(qty)).toHaveValue('2');
  await expect(blue.locator(qty)).toHaveValue('1');
  await expect(page.getByTestId('cart-total-value')).toContainText(money(redAmount + second.price));
  await info.attach('01-cart-before.png', { body: await page.getByRole('main').screenshot(), contentType: 'image/png' });

  const remove = blue.getByRole('button', { name: /remove|delete/i })
    .or(blue.getByRole('link', { name: /remove|delete/i }));
  await expect(remove).toHaveCount(1);
  await remove.click();
  await expect(blue).toHaveCount(0);
  await expect(page.getByTestId('cart-total-value')).toContainText(money(redAmount));
  await page.reload();
  await expect(productRows).toHaveCount(1);
  await expect(red.locator(qty)).toHaveValue('2');
  await expect(page.getByTestId('cart-total-value')).toContainText(money(redAmount));
  const saved = await cart(page.request);
  expect(saved.items).toHaveLength(1);
  expect(saved.items[0]).toMatchObject({ variant_id: first.id, quantity: 2, final_line_price: redAmount });
  expect(saved.item_count).toBe(2);
  expect(saved.total_price).toBe(redAmount);
  await info.attach('02-cart-reloaded.png', { body: await page.getByRole('main').screenshot(), contentType: 'image/png' });

  await page.getByRole('button', { name: /^check\s*out$/i }).click();
  await expect(page).toHaveURL(/\/checkouts?\//);
  const summaryRows = page.getByRole('row').filter({ visible: true });
  const notebookRows = summaryRows.filter({ has: page.getByRole('cell', { name: /^QA Notebook\b/i }) });
  const checkoutRed = notebookRows.filter({ has: page.getByRole('cell', { name: 'QA Notebook Red', exact: true }) });
  await expect(notebookRows).toHaveCount(1);
  await expect(checkoutRed.getByRole('cell', { name: '2', exact: true })).toHaveCount(1);
  await expect(checkoutRed.getByRole('cell', { name: money(redAmount), exact: true })).toBeVisible();
  const subtotal = summaryRows.filter({ has: page.getByRole('rowheader', { name: 'Subtotal', exact: true }) });
  const subtotalCell = subtotal.getByRole('cell', { name: money(redAmount), exact: true });
  await expect(subtotalCell).toBeVisible();
  await info.attach('03-checkout-line.png', { body: await checkoutRed.screenshot(), contentType: 'image/png' });
  await info.attach('04-checkout-subtotal.png', { body: await subtotal.screenshot(), contentType: 'image/png' });
  await info.attach('cart-to-checkout.json', {
    contentType: 'application/json',
    body: JSON.stringify({ remainingVariantId: saved.items[0].variant_id,
      quantity: saved.items[0].quantity, cartTotalCents: saved.total_price,
      checkoutLine: await checkoutRed.innerText(), checkoutSubtotal: await subtotalCell.innerText() }, null, 2),
  });
});

test('SH-04 モバイルでカートから青の商品に戻り、同じ色をもう1冊追加する', async ({ page }, info) => {
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

  await page.goto(root + 'cart');
  const cartForm = page.locator('#cart-form');
  const productLink = cartForm.getByRole('link', { name: /QA Notebook/i })
    .filter({ visible: true }).first();
  await expect(productLink).toBeVisible();
  await productLink.click();
  await expect(page).toHaveURL(/\/products\/qa-notebook\/?(?:[?#].*)?$/);

  // 色を選び直さず、戻った時点で購入フォームが青を指しているか確認する。
  const main = page.getByRole('main');
  const addButton = main.getByRole('button', { name: /add to cart/i })
    .filter({ visible: true }).first();
  const purchaseForm = main.locator('form').filter({ has: page.getByRole('button', { name: /add to cart/i }).filter({ visible: true }) });
  await expect(purchaseForm).toHaveCount(1);
  await expect(purchaseForm.locator('[name="id"]')).toHaveValue(String(second.id));
  await info.attach('01-returned-product.png', {
    body: await page.screenshot(), contentType: 'image/png',
  });

  const added = page.waitForResponse(response =>
    response.request().method() === 'POST' &&
    /\/cart\/add(?:\.js)?\/?$/.test(new URL(response.url()).pathname)
  );
  await addButton.click();
  expect((await added).ok()).toBe(true);

  await page.goto(root + 'cart');
  await page.reload();
  const finalCart = page.locator('#cart-form');
  await expect(finalCart).toContainText('Blue');
  const quantity = finalCart.locator('input[type="number"]:visible');
  await expect(quantity).toHaveCount(1);
  await expect(quantity).toHaveValue('2');

  const finalState = await cart(page.request);
  expect(finalState.items).toHaveLength(1);
  expect(finalState.items[0]).toMatchObject({
    variant_id: second.id, quantity: 2, final_line_price: second.price * 2,
  });
  expect(finalState.item_count).toBe(2);
  expect(finalState.total_price).toBe(second.price * 2);

  await info.attach('02-cart-after-return.png', {
    body: await page.screenshot(), contentType: 'image/png',
  });
  await info.attach('cart-return-result.json', {
    body: JSON.stringify({
      variant_id: finalState.items[0].variant_id,
      quantity: finalState.items[0].quantity,
      line_price: finalState.items[0].final_line_price,
      total_price: finalState.total_price,
    }, null, 2),
    contentType: 'application/json',
  });
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

test('SH-07 ゲストのテスト決済を店舗の受注と照合する', async ({ page, playwright }, info) => {
  test.skip(process.env.SHOPIFY_TEST_ORDER !== '1', 'Opt in to creating one test order.');
  test.setTimeout(150_000);
  const store = 'nha6ki-qa-lab.myshopify.com';
  expect(new URL(root).hostname).toBe(store);
  const token = process.env.SHOPIFY_ADMIN_READ_TOKEN;
  if (!token) throw new Error('Set SHOPIFY_ADMIN_READ_TOKEN for this store (read_orders).');
  const admin = await playwright.request.newContext();
  async function orders(lookup: string) {
    const response = await admin.post('https://' + store + '/admin/api/2026-10/graphql.json', {
      headers: { 'X-Shopify-Access-Token': token! }, maxRedirects: 0,
      data: { query: `query OrderCheck($q: String!) {
        orders(first: 2, query: $q) { nodes {
          name confirmationNumber test displayFinancialStatus
          lineItems(first: 5) { nodes { title variantTitle quantity } }
          subtotalPriceSet { presentmentMoney { amount currencyCode } }
          totalShippingPriceSet { presentmentMoney { amount currencyCode } }
          totalTaxSet { presentmentMoney { amount currencyCode } }
          totalPriceSet { presentmentMoney { amount currencyCode } }
        } }
      }`, variables: { q: 'confirmation_number:' + lookup } },
    });
    try {
      expect(response.status(), 'Admin API read_orders access').toBe(200);
      const body = await response.json();
      if (body.errors?.length) throw new Error('Admin API: ' + body.errors[0].message);
      return body.data.orders.nodes as Array<{
        name: string; confirmationNumber: string; test: boolean; displayFinancialStatus: string;
        lineItems: { nodes: Array<{ title: string; variantTitle: string; quantity: number }> };
      } & Record<'subtotalPriceSet' | 'totalShippingPriceSet' | 'totalTaxSet' | 'totalPriceSet',
        { presentmentMoney: { amount: string; currencyCode: string } }>>;
    } finally { await response.dispose(); }
  }

  try {
    await orders('SH07PREFLIGHT');
    await change(page.request, 'add', { items: [{ id: first.id, quantity: 2 }, { id: second.id, quantity: 1 }] });
    await page.goto(root + 'cart');
    await page.getByRole('button', { name: /^check\s*out$/i }).click();
    await expect(page).toHaveURL(/\/checkouts?\//);
    const input = (name: string) => page.locator('input[name="' + name + '"]:visible').first();
    await input('email').fill('sh07-' + Date.now() + '@example.com');
    const country = page.locator('select[name="countryCode"]:visible').first();
    await country.selectOption('US');
    await input('firstName').fill('QA');
    await input('lastName').fill('Buyer');
    await input('address1').fill('1 Market Street');
    await input('city').fill('San Francisco');
    await page.locator('select[name="zone"]:visible').first().selectOption('CA');
    await input('postalCode').fill('94105');
    await input('postalCode').press('Tab');

    await expect(page.getByText(/to simulate an approved transaction/i)).toBeVisible();
    async function paymentInput(label: RegExp, selector: string) {
      const inDocument = (scope: Frame) =>
        scope.locator(selector).or(scope.getByRole('textbox', { name: label }))
          .and(scope.locator('input:visible'));
      async function candidates() {
        const found: Locator[] = [];
        for (const frame of page.frames()) {
          if (frame !== page.mainFrame()) {
            if (frame.isDetached()) continue;
            const host = await frame.frameElement();
            try {
              if (!await host.isVisible() || !label.test(await host.getAttribute('title') || '')) continue;
            } finally { await host.dispose(); }
          }
          found.push(...await inDocument(frame).all());
        }
        return found;
      }
      let matches: Locator[] = [];
      await expect.poll(async () => {
        matches = await candidates();
        return matches.length;
      }, { timeout: 12000, message: 'Identify one payment input for ' + label }).toBe(1);
      return matches[0];
    }
    const fields = [
      { label: /card number/i, selector: 'input[autocomplete="cc-number"], input[name="number"]',
        value: '1', expected: /^\s*1\s*$/ },
      { label: /expir(y|ation)/i, selector: 'input[autocomplete="cc-exp"], input[name="expiry"]',
        value: '1230', expected: /^12\s*\/?\s*(?:20)?30$/ },
      { label: /security code|verification (code|value)|CVV/i,
        selector: 'input[autocomplete="cc-csc"], input[name="verification_value"]',
        value: '111', expected: /^111$/ },
      { label: /name on card|cardholder|card holder/i,
        selector: 'input[autocomplete="cc-name"], input[name="name"][id="name"]',
        value: 'Test payment gateway', expected: /^Test payment gateway$/ },
    ];
    for (const field of fields) {
      await test.step('Fill ' + field.label.source, async () => {
        const target = await paymentInput(field.label, field.selector);
        await target.fill('');
        if (field.selector.includes('cc-exp')) {
          await target.fill('12 / 30');
        } else {
          await target.pressSequentially(field.value);
        }
        await target.press('Tab');
        await expect(target).toHaveValue(field.expected);
      });
    }

    const row = (name: RegExp) => page.getByRole('row').filter({
      has: page.getByRole('rowheader', { name }), visible: true,
    });
    async function amount(name: RegExp) {
      const cell = row(name).getByRole('cell').last();
      let cents: number | undefined;
      await expect.poll(async () => {
        // Read one rendered value per attempt, including while checkout recalculates.
        const text = (await cell.allInnerTexts()).join(' ').replace(/\s+/g, ' ').trim();
        const match = text.match(/^(?:USD\s*)?\$\s*(\d[\d,]*)\.(\d{2})(?:\s*USD)?$/i);
        if (match) {
          cents = Number(match[1].replace(/,/g, '')) * 100 + Number(match[2]);
        } else if (name.test('Shipping') && /^(?:free|free shipping)$/i.test(text)) {
          cents = 0;
        } else {
          return text || '(no rendered amount)';
        }
        return 'parsed';
      }, { timeout: 20000, message: 'Read checkout amount for ' + name }).toBe('parsed');
      if (cents === undefined) throw new Error('Missing checkout amount for ' + name);
      return cents;
    }
    for (const [variant, count] of [[first, 2], [second, 1]] as const) {
      const line = page.getByRole('row').filter({ has: page.getByRole('cell', {
        name: 'QA Notebook ' + variant.option1, exact: true }), visible: true });
      await expect(line.getByRole('cell', { name: String(count), exact: true })).toHaveCount(1);
    }
    const shipping = await amount(/^Shipping$/i);
    const subtotal = await amount(/^Subtotal/i);
    const tax = await row(/tax/i).count() ? await amount(/tax/i) : 0;
    const total = await amount(/^Total$/i);
    expect(subtotal).toBe(first.price * 2 + second.price);
    expect(total).toBe(subtotal + shipping + tax);
    await expect(row(/^Total$/i)).toContainText('USD');

    for (const field of fields) {
      await expect(await paymentInput(field.label, field.selector)).toHaveValue(field.expected);
    }
    await page.getByRole('button', { name: /^(?:pay now|complete order)(?:\s+\$\s*[\d,]+\.\d{2})?$/i }).click({ timeout: 15000 });
    const confirmation = page.getByText(/Confirmation\s*#\s*[A-Z\d]+/i).filter({ visible: true }).first();
    await expect(confirmation).toBeVisible({ timeout: 25000 });
    const code = (await confirmation.innerText()).match(/Confirmation\s*#\s*([A-Z\d]+)/i)![1];
    let matches: Awaited<ReturnType<typeof orders>> = [];
    await expect.poll(async () => {
      matches = (await orders(code)).filter(order => order.confirmationNumber === code);
      return matches.length;
    }, { timeout: 30000, intervals: [1000, 2500, 5000] }).toBe(1);
    const order = matches[0];
    expect(order.test).toBe(true);
    expect(order.displayFinancialStatus).toBe('PAID');
    expect(order.lineItems.nodes).toHaveLength(2);
    for (const [variant, count] of [[first, 2], [second, 1]] as const) {
      expect(order.lineItems.nodes).toContainEqual({ title: 'QA Notebook', variantTitle: variant.option1, quantity: count });
    }
    for (const [field, cents] of [['subtotalPriceSet', subtotal], ['totalShippingPriceSet', shipping],
      ['totalTaxSet', tax], ['totalPriceSet', total]] as const) {
      const money = order[field].presentmentMoney;
      expect(money.currencyCode).toBe('USD');
      expect(Math.round(Number(money.amount) * 100), field).toBe(cents);
    }
    await info.attach('order-comparison.json', { contentType: 'application/json',
      body: JSON.stringify({ order: order.name, red: 2, blue: 1, currency: 'USD',
        subtotalCents: subtotal, shippingCents: shipping, taxCents: tax, totalCents: total, testOrder: true }, null, 2) });
  } finally { await admin.dispose(); }
});
