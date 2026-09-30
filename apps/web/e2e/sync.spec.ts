import { expect, test, type Page } from '@playwright/test';
import {
  api,
  debug,
  drag,
  ids,
  idsFor,
  openApp,
  panel,
  proxy,
  row,
  selectViaApi,
  serverVersion,
  setFilter,
  uniquePrefix,
} from './helpers.js';

const leaderOf = async (pages: Page[]) => {
  const flags = await Promise.all(pages.map((p) => debug(p).then((d) => d.isLeader)));
  return flags;
};

test.describe('sync between tabs and browsers', () => {
  test('T19: a move in A is visible in B ≤ 2 s; concurrent moves converge', async ({
    browser,
    request,
  }) => {
    const p = uniquePrefix();
    const [a, b, c, d] = idsFor(p);
    await selectViaApi(request, [a!, b!, c!, d!]);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    await Promise.all([openApp(A), openApp(B)]);
    await Promise.all([setFilter(A, 'selected', p), setFilter(B, 'selected', p)]);
    await expect.poll(() => ids(B, 'selected')).toEqual([a, b, c, d]);

    await drag(A, row(A, 'selected', d!).locator('.drag-handle'), row(A, 'selected', a!), 'above');
    const t0 = Date.now();
    await expect
      .poll(() => ids(B, 'selected'), { timeout: 2000, intervals: [50] })
      .toEqual([d, a, b, c]);
    const delay = Date.now() - t0;
    test.info().annotations.push({ type: 'T19 propagation ms', description: String(delay) });

    await Promise.all([
      (async () => {
        await row(A, 'selected', b!).focus();
        await A.keyboard.press('Alt+Home');
      })(),
      (async () => {
        await row(B, 'selected', c!).focus();
        await B.keyboard.press('Alt+Home');
      })(),
    ]);
    await expect.poll(() => debug(A).then((x) => x.ops), { timeout: 5000 }).toBe(0);
    await expect.poll(() => debug(B).then((x) => x.ops), { timeout: 5000 }).toBe(0);
    const server = (await api(request, 'GET', `/api/selected?filter=${p}`)).body.items.map(
      (i: { id: number }) => i.id,
    );
    await expect.poll(() => ids(A, 'selected')).toEqual(server);
    await expect.poll(() => ids(B, 'selected')).toEqual(server);
    expect(server.slice(0, 2).sort()).toEqual([b, c].sort());
    await ctxA.close();
    await ctxB.close();
  });

  test('T31: three tabs share one SSE stream; closing the leader hands over without losses', async ({
    browser,
    request,
  }) => {
    const ctx = await browser.newContext();
    const tabs = [await ctx.newPage(), await ctx.newPage(), await ctx.newPage()];
    for (const t of tabs) await openApp(t);
    await expect.poll(async () => (await proxy(request, 'sse')).sse).toBe(1);
    const leaders = await leaderOf(tabs);
    expect(leaders.filter(Boolean)).toHaveLength(1);
    const leaderIndex = leaders.indexOf(true);

    const p = uniquePrefix();
    const [a, b] = idsFor(p);
    for (const t of tabs) await setFilter(t, 'selected', p);
    await selectViaApi(request, [a!]);
    for (const t of tabs) await expect(row(t, 'selected', a!)).toBeVisible({ timeout: 3000 });

    await tabs[leaderIndex]!.close();
    const rest = tabs.filter((_, i) => i !== leaderIndex);
    const t0 = Date.now();
    await expect
      .poll(async () => (await leaderOf(rest)).filter(Boolean).length, {
        timeout: 3000,
        intervals: [100],
      })
      .toBe(1);
    test.info().annotations.push({ type: 'T31 handover ms', description: String(Date.now() - t0) });
    await expect.poll(async () => (await proxy(request, 'sse')).sse, { timeout: 5000 }).toBe(1);

    await selectViaApi(request, [b!]);
    for (const t of rest) await expect(row(t, 'selected', b!)).toBeVisible({ timeout: 3000 });
    const version = await serverVersion(request);
    for (const t of rest)
      await expect.poll(() => debug(t).then((d) => d.version)).toBeGreaterThanOrEqual(version);
    await ctx.close();
  });

  test('T29: SSE unavailable → polling ≤ 25 s; changes still arrive; back to SSE after unblocking', async ({
    browser,
    request,
  }) => {
    test.setTimeout(150_000);
    const ctx = await browser.newContext();
    await ctx.route('**/api/events*', (route) => route.abort('connectionrefused'));
    const page = await ctx.newPage();
    const t0 = Date.now();
    await page.goto('/');
    await expect
      .poll(() => debug(page).then((d) => d.connection.mode), { timeout: 25_000, intervals: [250] })
      .toBe('polling');
    test
      .info()
      .annotations.push({ type: 'T29 switch to polling ms', description: String(Date.now() - t0) });
    await expect(page.getByTestId('connection')).toHaveText('Обновления с задержкой');

    const p = uniquePrefix();
    const [a] = idsFor(p);
    await setFilter(page, 'selected', p);
    await selectViaApi(request, [a!]);
    await expect(row(page, 'selected', a!)).toBeVisible({ timeout: 3000 });

    await ctx.unroute('**/api/events*');
    await expect
      .poll(() => debug(page).then((d) => d.connection.mode), { timeout: 61_000, intervals: [500] })
      .toBe('sse');
    await expect(page.getByTestId('connection')).toHaveText('Онлайн');
    await ctx.close();
  });

  test('T30: a silent (half-open) stream is detected ≤ 45 s; missed events are replayed', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await openApp(page);
    const p = uniquePrefix();
    const [a, b] = idsFor(p);
    await setFilter(page, 'selected', p);
    await expect(panel(page, 'selected').getByText('Ничего не найдено')).toBeVisible();
    const before = await debug(page);
    await proxy(request, 'freeze');
    try {
      const t0 = Date.now();
      await selectViaApi(request, [a!, b!]);
      await page.waitForTimeout(3000);
      await expect(row(page, 'selected', a!)).toHaveCount(0);
      await proxy(request, 'unfreeze');
      await expect(row(page, 'selected', b!)).toBeVisible({ timeout: 45_000 });
      test
        .info()
        .annotations.push({ type: 'T30 recovery ms', description: String(Date.now() - t0) });
    } finally {
      await proxy(request, 'unfreeze');
    }
    const after = await debug(page);
    expect(after.version).toBe(await serverVersion(request));
    expect(after.stats.engine.resyncs).toBe(before.stats.engine.resyncs);
    expect(after.stats.engine.catchUps).toBe(before.stats.engine.catchUps);
    expect(await ids(page, 'selected')).toEqual([a, b]);
  });

  test('T32: server restart → the client resyncs to the new (empty) state', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const p = uniquePrefix();
    const [a] = idsFor(p);
    await selectViaApi(request, [a!]);
    await openApp(page);
    await setFilter(page, 'selected', p);
    await expect(row(page, 'selected', a!)).toBeVisible();
    await proxy(request, 'restart');
    await expect(page.getByText('Сервер перезапущен')).toBeVisible({ timeout: 20_000 });
    await expect(row(page, 'selected', a!)).toHaveCount(0);
    await expect(page.getByTestId('count-selected')).toHaveText('0');
    await expect(row(page, 'items', 1)).toBeVisible();
    await expect(page.getByTestId('connection')).toHaveText('Онлайн');
  });

  test('T32: the restarted server overtakes the client version before it reconnects', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const p = uniquePrefix();
    const [a, b, c] = idsFor(p);
    await selectViaApi(request, [a!]);
    await openApp(page);
    await setFilter(page, 'selected', p);
    await expect(row(page, 'selected', a!)).toBeVisible();
    const client = await debug(page);
    const oldInstance = await page.evaluate(
      () => (window as unknown as { __mim: { instance: string } }).__mim.instance,
    );
    await proxy(request, 'freeze');
    try {
      await proxy(request, 'restart');
      const filler = Array.from({ length: client.version! + 20 }, (_, i) => 500_000 + i);
      for (let i = 0; i < filler.length; i += 200) {
        const chunk = filler.slice(i, i + 200);
        const answers = await Promise.all(
          chunk.map((id) => api(request, 'POST', '/api/selected', { id })),
        );
        expect(answers.every((r) => r.status === 200)).toBe(true);
      }
      await selectViaApi(request, [c!, b!]);
      expect(await serverVersion(request)).toBeGreaterThan(client.version!);
    } finally {
      await proxy(request, 'unfreeze');
    }
    await expect(page.getByText('Сервер перезапущен')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => ids(page, 'selected'), { timeout: 30_000 }).toEqual([c, b]);
    const health = (await (await request.get('/api/health')).json()) as {
      instance: string;
      version: number;
    };
    const after = await page.evaluate(() => {
      const m = (window as unknown as { __mim: { instance: string; version: number } }).__mim;
      return { instance: m.instance, version: m.version };
    });
    expect(after.instance).toBe(health.instance);
    expect(after.instance).not.toBe(oldInstance);
    await expect.poll(() => debug(page).then((d) => d.version)).toBe(health.version);
    await expect(page.getByTestId('count-selected')).toHaveText(
      new Intl.NumberFormat('ru-RU').format(client.version! + 22),
    );
    expect((await debug(page)).ops).toBe(0);
  });
});
