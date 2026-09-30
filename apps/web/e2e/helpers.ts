import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

export type ListKind = 'items' | 'selected';

export function uniquePrefix(): string {
  return String(10_000 + Math.floor(Math.random() * 89_999));
}

export function idsFor(prefix: string): number[] {
  const ids = [
    Number(prefix),
    ...Array.from({ length: 10 }, (_, d) => Number(prefix + d)),
    ...Array.from({ length: 9 }, (_, d) => Number(String(d + 1) + prefix)),
  ];
  return [...new Set(ids)].filter((id) => id <= 1_000_000).sort((a, b) => a - b);
}

let keySeq = 0;
export async function api(
  request: APIRequestContext,
  method: 'POST' | 'DELETE' | 'PATCH' | 'GET',
  path: string,
  body?: unknown,
) {
  const res = await request.fetch(path, {
    method,
    data: body,
    headers: { 'Idempotency-Key': `e2e-${Date.now()}-${++keySeq}` },
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

export async function selectViaApi(request: APIRequestContext, ids: number[]) {
  for (const id of ids)
    expect((await api(request, 'POST', '/api/selected', { id })).status).toBe(200);
}

export const panel = (page: Page, list: ListKind): Locator => page.locator(`[data-list="${list}"]`);
export const rows = (page: Page, list: ListKind): Locator =>
  panel(page, list).locator('[role="listitem"]');
export const row = (page: Page, list: ListKind, id: number): Locator =>
  panel(page, list).locator(`[data-id="${id}"]`);

export async function ids(page: Page, list: ListKind): Promise<number[]> {
  return rows(page, list).evaluateAll((els) =>
    els
      .map((el) => ({
        id: Number((el as HTMLElement).dataset.id),
        top: parseFloat((el as HTMLElement).style.top),
      }))
      .sort((a, b) => a.top - b.top)
      .map((x) => x.id),
  );
}

export async function setFilter(page: Page, list: ListKind, value: string) {
  const input = panel(page, list).getByRole('textbox', { name: /Фильтр/ });
  await input.fill(value);
  await input.press('Enter');
}

export async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText(/Онлайн/, { timeout: 15_000 });
  await expect(rows(page, 'items').first()).toBeVisible();
}

export async function drag(
  page: Page,
  from: Locator,
  to: Locator,
  where: 'above' | 'below' | 'center' = 'center',
) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  const y =
    where === 'above'
      ? b.y + b.height * 0.25
      : where === 'below'
        ? b.y + b.height * 0.75
        : b.y + b.height / 2;
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 50, a.y + a.height / 2 + 5, { steps: 3 });
  await page.mouse.move(b.x + 60, y, { steps: 12 });
  await page.waitForTimeout(100);
  await page.mouse.move(b.x + 61, y, { steps: 2 });
  await page.mouse.up();
}

export async function proxy(
  request: APIRequestContext,
  cmd: 'freeze' | 'unfreeze' | 'sse' | 'restart',
) {
  const res = await request.fetch(`/__proxy/${cmd}`, {
    method: cmd === 'sse' ? 'GET' : 'POST',
    timeout: 30_000,
  });
  return (await res.json()) as { frozen: boolean; sse: number };
}

export async function serverVersion(request: APIRequestContext): Promise<number> {
  const res = await request.get('/api/health');
  return ((await res.json()) as { version: number }).version;
}

export const debug = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as { __mim: Record<string, unknown> }).__mim;
    return {
      version: m.version as number | null,
      isLeader: m.isLeader as boolean,
      connection: m.connection as { mode: string; state: string },
      stats: m.stats as { engine: { resyncs: number; catchUps: number } },
      ops: m.ops as number,
    };
  });
