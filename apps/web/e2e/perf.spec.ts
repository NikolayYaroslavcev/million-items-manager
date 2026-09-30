import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { debug, panel, row, rows, setFilter } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const results: Record<string, unknown> = {};
const PORT = Number(process.env.E2E_PORT ?? 4000);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = `http://127.0.0.1:${PORT + 100}`;
const LONG_RUN_MS = Number(process.env.PERF_LONG_RUN_MS ?? 180_000);
const BENCH_ENV = { NODE_ENV: 'test', DEBUG_ENDPOINTS: 'true' };

async function call(
  base: string,
  p: string,
  method = 'GET',
  body?: unknown,
  key?: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(base + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function seedSelected(ids: number[]) {
  const started = Date.now();
  let next = 0;
  let retries = 0;
  const failures: string[] = [];
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      const key = randomUUID();
      for (let attempt = 0; ; attempt++) {
        let status = 0;
        let code = 'NETWORK';
        try {
          const r = await call(SERVER, '/api/selected', 'POST', { id }, key);
          status = r.status;
          code = r.body?.error?.code ?? '';
        } catch {}
        if (status === 200) break;
        if (attempt >= 20 || (status >= 400 && ![429, 503, 504].includes(status))) {
          failures.push(`${id}: ${status} ${code}`);
          break;
        }
        retries++;
        await new Promise((r) => setTimeout(r, 200 * Math.min(attempt + 1, 5)));
      }
    }
  };
  await Promise.all(Array.from({ length: 1000 }, worker));
  return { seconds: (Date.now() - started) / 1000, retries, failures };
}

async function verifyState(expectedSelected: number) {
  const inv = (await call(SERVER, '/api/debug/invariants')).body;
  expect(inv?.ok, `invariants: ${inv?.error}`).toBe(true);
  expect(inv.counts.selected).toBe(expectedSelected);
  return { selected: inv.counts.selected, version: inv.version, invariantsCheckMs: inv.ms };
}

async function heapMB(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const used = metrics.find((m) => m.name === 'JSHeapUsedSize')!.value;
  return Math.round((used / 1024 / 1024) * 10) / 10;
}

async function domNodes(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'Nodes')!.value;
}

async function startFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __long: number[]; __stop: boolean };
    w.__frames = [];
    w.__long = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - last);
      last = t;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push(e.duration);
    }).observe({ type: 'longtask', buffered: false });
  });
}

async function stopFrames(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __long: number[]; __stop: boolean };
    w.__stop = true;
    const f = w.__frames.slice(1).sort((a, b) => a - b);
    const q = (p: number) =>
      Math.round(f[Math.min(f.length - 1, Math.floor(f.length * p))]! * 10) / 10;
    return {
      frames: f.length,
      p50ms: q(0.5),
      p95ms: q(0.95),
      maxMs: Math.round(f[f.length - 1]! * 10) / 10,
      longTasks: w.__long.length,
      longestTaskMs: Math.round(Math.max(0, ...w.__long)),
    };
  });
}

const loaded = (page: Page, list: 'items' | 'selected') =>
  panel(page, list)
    .locator('.panel-meta')
    .innerText()
    .then((t) => Number(t.replace(/\D/g, '')));

async function measure(
  page: Page,
  out: Record<string, unknown>,
  opts: { writerIds: number[]; longRunMs: number; leftHasData: boolean },
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  const nav = Date.now();
  await page.goto('/');
  if (opts.leftHasData) await expect(rows(page, 'items').first()).toBeVisible();
  await expect(rows(page, 'selected').first()).toBeVisible();
  const firstRowsMs = Date.now() - nav;
  const timing = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      domContentLoadedMs: Math.round(n.domContentLoadedEventEnd),
      firstContentfulPaintMs: fcp ? Math.round(fcp.startTime) : null,
      transferKB: Math.round(
        performance
          .getEntriesByType('resource')
          .reduce(
            (s, r) => s + ((r as PerformanceResourceTiming).transferSize || 0),
            n.transferSize,
          ) / 1024,
      ),
    };
  });
  out.initialLoad = {
    ...timing,
    firstRowsBothListsMs: firstRowsMs,
    rowsLeft: await rows(page, 'items').count(),
    rowsRight: await rows(page, 'selected').count(),
    heapMB: await heapMB(cdp),
    domNodes: await domNodes(cdp),
  };

  const portionMs: number[] = [];
  const lists = opts.leftHasData ? (['items', 'selected'] as const) : (['selected'] as const);
  for (const list of lists) {
    const scroller = panel(page, list).locator('.list-scroll');
    for (let i = 0; i < 25; i++) {
      const before = await loaded(page, list);
      const s = Date.now();
      await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await expect.poll(() => loaded(page, list), { intervals: [25] }).toBeGreaterThan(before);
      portionMs.push(Date.now() - s);
    }
  }
  portionMs.sort((a, b) => a - b);
  out.infiniteScroll = {
    portions: portionMs.length,
    portionLatencyMs: {
      p50: portionMs[Math.floor(portionMs.length / 2)],
      p95: portionMs[Math.floor(portionMs.length * 0.95)],
      max: portionMs[portionMs.length - 1],
    },
    loadedLeft: await loaded(page, 'items'),
    loadedRight: await loaded(page, 'selected'),
    renderedRowsInDom: await page.locator('[role="listitem"]').count(),
    domNodes: await domNodes(cdp),
    heapMB: await heapMB(cdp),
  };

  const scrollList = opts.leftHasData ? 'items' : 'selected';
  await startFrames(page);
  const box = (await panel(page, scrollList).locator('.list-scroll').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await panel(page, scrollList)
    .locator('.list-scroll')
    .evaluate((el) => el.scrollTo({ top: 0 }));
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, i < 30 ? 400 : -400);
    await page.waitForTimeout(16);
  }
  out.scrollFrames = await stopFrames(page);

  const filterCases: [string, 'items' | 'selected', string][] = [
    ['left "5" (many matches)', 'items', '5'],
    ['left "999999" (few matches)', 'items', '999999'],
    ['left "1234567" (no base match)', 'items', '1234567'],
    ['left 16 digits (no match)', 'items', '9999999999999999'],
    ['right "7"', 'selected', '7'],
    ['right "123"', 'selected', '123'],
    ['right "999999" (rare)', 'selected', '999999'],
  ];
  const filters: Record<string, unknown> = {};
  await startFrames(page);
  for (const [name, list, value] of filterCases) {
    await setFilter(page, list, '');
    if (list === 'selected' || opts.leftHasData) {
      await expect.poll(() => loaded(page, list)).toBeGreaterThan(0);
    }
    const s = Date.now();
    await setFilter(page, list, value);
    await expect(panel(page, list).locator('.panel-meta')).toContainText('найдено', {
      timeout: 2000,
    });
    await expect
      .poll(
        async () => {
          const st = await panel(page, list).locator('.list-footer').innerText();
          const n = await rows(page, list).count();
          return (
            (n > 0 && !st.includes('Загрузка') && !st.includes('Поиск')) ||
            /Ничего не найдено|Конец списка|Продолжить поиск/.test(st)
          );
        },
        { timeout: 60_000, intervals: [25] },
      )
      .toBe(true);
    filters[name] = {
      firstResultOrDoneMs: Date.now() - s,
      found: await loaded(page, list),
      footer: (await panel(page, list).locator('.list-footer').innerText()).trim(),
    };
  }
  out.filters = filters;
  out.filterFrames = await stopFrames(page);
  await setFilter(page, 'items', '');
  await setFilter(page, 'selected', '');

  await expect.poll(() => loaded(page, 'selected')).toBeGreaterThan(2);
  const ops: Record<string, unknown> = {};
  if (opts.leftHasData) {
    await expect.poll(() => loaded(page, 'items')).toBeGreaterThan(0);
    const target = Number(await rows(page, 'items').nth(3).getAttribute('data-id'));
    const s = Date.now();
    await row(page, 'items', target)
      .getByRole('button', { name: `Выбрать ${target}` })
      .click();
    await expect(row(page, 'items', target)).toHaveCount(0);
    ops.selectOptimisticMs = Date.now() - s;
    await expect.poll(() => debug(page).then((d) => d.ops), { intervals: [20] }).toBe(0);
    ops.selectConfirmedMs = Date.now() - s;
  } else {
    const target = Number(await rows(page, 'selected').nth(3).getAttribute('data-id'));
    const s = Date.now();
    await row(page, 'selected', target)
      .getByRole('button', { name: `Снять выбор ${target}` })
      .click();
    await expect(row(page, 'selected', target)).toHaveCount(0);
    ops.deselectOptimisticMs = Date.now() - s;
    await expect.poll(() => debug(page).then((d) => d.ops), { intervals: [20] }).toBe(0);
    ops.deselectConfirmedMs = Date.now() - s;
  }
  const second = Number(await rows(page, 'selected').nth(1).getAttribute('data-id'));
  await row(page, 'selected', second).focus();
  const s = Date.now();
  await page.keyboard.press('Alt+ArrowUp');
  await expect
    .poll(() => rows(page, 'selected').first().getAttribute('data-id'))
    .toBe(String(second));
  ops.moveOptimisticMs = Date.now() - s;
  await expect.poll(() => debug(page).then((d) => d.ops), { intervals: [20] }).toBe(0);
  ops.moveConfirmedMs = Date.now() - s;
  ops.note =
    'confirmation = server answer + change delivered through the journal; the server batches every 1 s';
  out.operations = ops;

  const heapStart = await heapMB(cdp);
  const writerStatus: Record<string, number> = {};
  const writerNetworkErrors: Record<string, number> = {};
  let writes = 0;
  let stop = false;
  const ids = opts.writerIds;
  const writer = (async () => {
    let n = 0;
    while (!stop) {
      const id = ids[Math.floor(Math.random() * ids.length)]!;
      const other = ids[Math.floor(Math.random() * ids.length)]!;
      const k = n++ % 4;
      const tasks: Promise<number>[] = [];
      for (let j = 0; j < 20; j++) {
        const x = ids[(ids.indexOf(id) + j) % ids.length]!;
        const key = randomUUID();
        const once = () =>
          k === 0
            ? call(BASE, `/api/selected/${x}`, 'DELETE', undefined, key)
            : k === 1
              ? call(BASE, '/api/selected', 'POST', { id: x }, key)
              : call(
                  BASE,
                  '/api/selected/order',
                  'PATCH',
                  { id: x, afterId: other, beforeId: null },
                  key,
                );
        const send = async (): Promise<number> => {
          for (let attempt = 0; ; attempt++) {
            try {
              return (await once()).status;
            } catch (e) {
              const cause = (e as { cause?: { code?: string } }).cause?.code ?? 'NETWORK';
              writerNetworkErrors[cause] = (writerNetworkErrors[cause] ?? 0) + 1;
              if (attempt >= 3) return 0;
            }
          }
        };
        tasks.push(send());
      }
      for (const status of await Promise.all(tasks)) {
        writerStatus[status] = (writerStatus[status] ?? 0) + 1;
      }
      writes += tasks.length;
    }
  })();
  await startFrames(page);
  const heapSamples: number[] = [];
  const started = Date.now();
  while (Date.now() - started < opts.longRunMs) {
    await page.waitForTimeout(Math.min(30_000, opts.longRunMs / 4));
    heapSamples.push(await heapMB(cdp));
    await panel(page, 'selected')
      .locator('.list-scroll')
      .evaluate((el) => el.scrollBy({ top: 500 }));
  }
  stop = true;
  await writer;
  const frames = await stopFrames(page);
  await page.waitForTimeout(3000);
  const d = await debug(page);
  const serverVersion = (await call(BASE, '/api/health')).body.version;
  const clientRight = await page.evaluate(() =>
    (window as unknown as { __mim: { debugRightIds(): number[] } }).__mim.debugRightIds(),
  );
  const serverRight: number[] = [];
  let cursor: string | null = null;
  while (serverRight.length < clientRight.length) {
    const body = (await call(BASE, `/api/selected?limit=20${cursor ? `&cursor=${cursor}` : ''}`))
      .body as { items: { id: number }[]; nextCursor: string | null };
    serverRight.push(...body.items.map((i) => i.id));
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  const inv = (await call(SERVER, '/api/debug/invariants')).body;
  out.longRun = {
    durationSec: opts.longRunMs / 1000,
    serverWrites: writes,
    writesPerSec: Math.round(writes / (opts.longRunMs / 1000)),
    writerStatuses: writerStatus,
    writerNetworkErrorsRetriedWithSameKey: writerNetworkErrors,
    clientVersion: d.version,
    serverVersion,
    resyncs: d.stats.engine.resyncs,
    heapMB: { start: heapStart, samples: heapSamples, end: await heapMB(cdp) },
    domNodes: await domNodes(cdp),
    frames,
    rightWindowEqualsServer:
      JSON.stringify(serverRight.slice(0, clientRight.length)) === JSON.stringify(clientRight),
    rightWindowSize: clientRight.length,
    serverInvariantsAfter: inv?.ok,
  };
  expect(d.version).toBe(serverVersion);
  expect((out.longRun as { rightWindowEqualsServer: boolean }).rightWindowEqualsServer).toBe(true);
  expect(inv?.ok).toBe(true);
  expect(writerStatus['0'] ?? 0, 'writer requests without an answer').toBe(0);
  expect(writerStatus['500'] ?? 0).toBe(0);
}

test.describe.configure({ mode: 'serial' });

test('perf http20k: 1 000 000 base IDs, 20 000 selected through the API', async ({ page }) => {
  const out: Record<string, unknown> = {};
  results.http20k = out;
  await call(BASE, `/__proxy/restart?env=${encodeURIComponent(JSON.stringify(BENCH_ENV))}`, 'POST');
  const ids = Array.from({ length: 20_000 }, (_, i) => 1 + i * 37);
  const seed = await seedSelected(ids);
  expect(seed.failures, 'every seed request must be applied').toEqual([]);
  out.seed = { requested: ids.length, ...seed, verified: await verifyState(ids.length) };
  await measure(page, out, { writerIds: ids, longRunMs: LONG_RUN_MS, leftHasData: true });
});

test('perf fixture1m: all 1 000 000 base IDs selected', async ({ page }) => {
  const out: Record<string, unknown> = {};
  results.fixture1m = out;
  const t0 = Date.now();
  const env = { ...BENCH_ENV, SEED_SELECTED: '1000000' };
  await call(BASE, `/__proxy/restart?env=${encodeURIComponent(JSON.stringify(env))}`, 'POST');
  out.seed = {
    method: 'SEED_SELECTED fixture at server start',
    seconds: (Date.now() - t0) / 1000,
    verified: await verifyState(1_000_000),
  };
  const writerIds = Array.from({ length: 20_000 }, (_, i) => 1 + i * 50);
  await measure(page, out, {
    writerIds,
    longRunMs: Math.min(LONG_RUN_MS, 120_000),
    leftHasData: false,
  });
});

test.afterAll(async () => {
  await call(BASE, '/__proxy/restart', 'POST').catch(() => {});
  const out = path.resolve(here, '../perf-results.json');
  writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), ...results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
});
