import { expect, test } from '@playwright/test';
import {
  api,
  drag,
  ids,
  idsFor,
  openApp,
  panel,
  row,
  rows,
  selectViaApi,
  setFilter,
  uniquePrefix,
} from './helpers.js';

test.describe('lists and operations', () => {
  test('T21: first load shows ≤ 20 per list; scrolling loads exactly the next ≤ 20', async ({
    page,
    request,
  }) => {
    const p = uniquePrefix();
    const current = (await api(request, 'GET', '/api/selected?limit=1')).body.counts.selected;
    if (current < 45) {
      const extra = idsFor(p).concat(idsFor(uniquePrefix()), idsFor(uniquePrefix()));
      await Promise.all(
        extra.slice(0, 45 - current).map((id) => api(request, 'POST', '/api/selected', { id })),
      );
    }
    const pages: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/(items|selected)\?/.test(r.url())) pages.push(r.url());
    });
    await openApp(page);
    await expect(panel(page, 'items')).toContainText('загружено 20');
    await expect(panel(page, 'selected')).toContainText('загружено 20');
    expect(pages.every((u) => u.includes('limit=20'))).toBe(true);
    await page.waitForTimeout(1500);
    await expect(panel(page, 'items')).toContainText('загружено 20');

    const before = pages.length;
    await panel(page, 'items')
      .locator('.list-scroll')
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(panel(page, 'items')).toContainText('загружено 40');
    await page.waitForTimeout(1500);
    await expect(panel(page, 'items')).toContainText('загружено 40');
    expect(pages.length - before).toBe(1);

    await panel(page, 'selected')
      .locator('.list-scroll')
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(panel(page, 'selected')).toContainText('загружено 40');
  });

  test('select, deselect and filter against the real server', async ({ page }) => {
    const p = uniquePrefix();
    const [a, b] = idsFor(p);
    await openApp(page);
    await setFilter(page, 'items', p);
    await expect(row(page, 'items', a!)).toBeVisible();
    for (const id of await ids(page, 'items')) expect(String(id)).toContain(p);

    await row(page, 'items', a!)
      .getByRole('button', { name: `Выбрать ${a}` })
      .click();
    await expect(row(page, 'items', a!)).toHaveCount(0);
    await setFilter(page, 'selected', p);
    await expect(row(page, 'selected', a!)).toBeVisible({ timeout: 3000 });

    await row(page, 'items', b!).focus();
    await page.keyboard.press('Enter');
    await expect(row(page, 'selected', b!)).toBeVisible({ timeout: 3000 });
    expect(await ids(page, 'selected')).toEqual([a, b]);

    await row(page, 'selected', a!)
      .getByRole('button', { name: `Снять выбор ${a}` })
      .click();
    await expect(row(page, 'selected', a!)).toHaveCount(0);
    await expect(row(page, 'items', a!)).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('Ничего не найдено')).toHaveCount(0);
    await setFilter(page, 'items', '9876543210123456');
    await expect(panel(page, 'items').getByText('Ничего не найдено')).toBeVisible({
      timeout: 5000,
    });
  });

  test('add an ID: queued badge, applied within the 10 s batch, duplicates refused', async ({
    page,
  }) => {
    const id = 5_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
    await openApp(page);
    const input = page.getByRole('textbox', { name: 'Новый ID' });
    const add = page.getByRole('button', { name: 'Добавить' });

    await input.fill('999');
    await expect(page.getByText('уже существуют')).toBeVisible();
    await expect(add).toBeDisabled();
    await input.fill('12ab3');
    await expect(input).toHaveValue('123');

    await input.fill(String(id));
    await add.click();
    const chip = page.getByRole('list', { name: 'Очередь добавления' }).getByText(String(id));
    await expect(chip).toBeVisible();
    await input.fill(String(id));
    await expect(page.getByText('Этот ID уже в очереди')).toBeVisible();
    await input.fill('');
    await expect(page.getByText(`ID ${id} добавлен`)).toBeVisible({ timeout: 12_000 });

    await setFilter(page, 'items', String(id));
    await expect(row(page, 'items', id)).toContainText('добавлен');
    await expect(page.getByTestId('count-all')).not.toHaveText('1 000 000');

    await input.fill(String(id));
    await add.click();
    await expect(page.getByText(/уже существует/)).toBeVisible({ timeout: 5000 });
  });

  test('DnD reorder under a filter; T20: order survives a reload, filters do not', async ({
    page,
    request,
  }) => {
    const p = uniquePrefix();
    const [a, b, c, d] = idsFor(p);
    await selectViaApi(request, [a!, b!, c!, d!]);
    await openApp(page);
    await setFilter(page, 'selected', p);
    await expect.poll(() => ids(page, 'selected')).toEqual([a, b, c, d]);

    await drag(
      page,
      row(page, 'selected', d!).locator('.drag-handle'),
      row(page, 'selected', a!),
      'above',
    );
    await expect.poll(() => ids(page, 'selected')).toEqual([d, a, b, c]);
    await expect.poll(() => page.evaluate(() => (window as any).__mim.ops)).toBe(0);

    await page.reload();
    await expect(panel(page, 'selected').getByRole('textbox', { name: /Фильтр/ })).toHaveValue('');
    await expect(panel(page, 'items').getByRole('textbox', { name: /Фильтр/ })).toHaveValue('');
    await setFilter(page, 'selected', p);
    await expect.poll(() => ids(page, 'selected')).toEqual([d, a, b, c]);
  });

  test('DnD from the left list inserts at the drop position; drag back deselects', async ({
    page,
    request,
  }) => {
    const p = uniquePrefix();
    const [a, b, c] = idsFor(p);
    await selectViaApi(request, [a!, b!]);
    await openApp(page);
    await setFilter(page, 'selected', p);
    await setFilter(page, 'items', p);
    await expect(row(page, 'items', c!)).toBeVisible();
    await expect.poll(() => ids(page, 'selected')).toEqual([a, b]);

    await drag(page, row(page, 'items', c!), row(page, 'selected', b!), 'above');
    await expect.poll(() => ids(page, 'selected')).toEqual([a, c, b]);
    await expect
      .poll(() => page.evaluate(() => (window as any).__mim.ops), { timeout: 5000 })
      .toBe(0);
    expect(await ids(page, 'selected')).toEqual([a, c, b]);

    await drag(
      page,
      row(page, 'selected', a!).locator('.drag-handle'),
      rows(page, 'items').first(),
    );
    await expect(row(page, 'selected', a!)).toHaveCount(0);
    await expect(row(page, 'items', a!)).toBeVisible({ timeout: 3000 });
  });

  test('keyboard move and the row menu', async ({ page, request }) => {
    const p = uniquePrefix();
    const [a, b, c] = idsFor(p);
    await selectViaApi(request, [a!, b!, c!]);
    await openApp(page);
    await setFilter(page, 'selected', p);
    await expect.poll(() => ids(page, 'selected')).toEqual([a, b, c]);

    await row(page, 'selected', c!).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => ids(page, 'selected')).toEqual([a, c, b]);
    await expect(row(page, 'selected', c!)).toBeFocused();

    await row(page, 'selected', b!).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'В начало' }).click();
    await expect.poll(() => ids(page, 'selected')).toEqual([b, a, c]);

    await row(page, 'selected', a!).focus();
    await page.keyboard.press('Delete');
    await expect(row(page, 'selected', a!)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).__mim.ops), { timeout: 5000 })
      .toBe(0);
    await page.reload();
    await setFilter(page, 'selected', p);
    await expect.poll(() => ids(page, 'selected')).toEqual([b, c]);
  });

  test('server refusal rolls back; a failed request offers a retry with the same key', async ({
    page,
    request,
  }) => {
    const p = uniquePrefix();
    const [a, b] = idsFor(p);
    await selectViaApi(request, [a!, b!]);
    await openApp(page);
    await setFilter(page, 'selected', p);
    await expect.poll(() => ids(page, 'selected')).toEqual([a, b]);

    await page.route('**/api/selected/order', async (route) => {
      await api(request, 'DELETE', `/api/selected/${a}`);
      await route.continue();
    });
    await drag(
      page,
      row(page, 'selected', b!).locator('.drag-handle'),
      row(page, 'selected', a!),
      'above',
    );
    await expect(page.getByText(/Перемещение .*(соседний элемент|уже не выбран)/)).toBeVisible();
    await page.unroute('**/api/selected/order');
    await expect.poll(() => ids(page, 'selected')).toEqual([b]);

    const keys: string[] = [];
    let fail = true;
    await page.route('**/api/selected', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      keys.push(route.request().headers()['idempotency-key']!);
      if (fail) await route.abort('connectionreset');
      else await route.continue();
    });
    await setFilter(page, 'items', p);
    await row(page, 'items', a!)
      .getByRole('button', { name: `Выбрать ${a}` })
      .click();
    await expect(page.getByText(/результат неизвестен/)).toBeVisible({ timeout: 10_000 });
    await expect(row(page, 'items', a!)).toBeVisible();
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1);
    fail = false;
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(row(page, 'selected', a!)).toBeVisible({ timeout: 5000 });
    expect(new Set(keys).size).toBe(1);
  });
});
