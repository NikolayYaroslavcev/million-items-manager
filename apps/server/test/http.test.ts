import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSse, sleep, startServer, type TestServer } from './helpers/http.js';

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(env: Record<string, string> = {}, opts = {}) {
  server = await startServer(env, opts);
  return server;
}

describe('reads', () => {
  it('first page has at most 20 items; limit is clamped; pages walk the whole list', async () => {
    const s = await start({ BASE_MAX: '45' });
    const first = await s.req('GET', '/api/items');
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(20);
    expect(first.body).toMatchObject({ done: false, version: 0, counts: { all: 45, selected: 0 } });
    expect((await s.req('GET', '/api/items?limit=100')).body.items).toHaveLength(20);
    expect((await s.req('GET', '/api/items?limit=0')).body.items).toHaveLength(1);
    const ids: number[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `?cursor=${cursor}` : '';
      const page = await s.req('GET', `/api/items${q}`);
      ids.push(...page.body.items.map((i: { id: number }) => i.id));
      cursor = page.body.nextCursor;
      expect(cursor === null).toBe(page.body.done);
    } while (cursor);
    expect(ids).toEqual([...Array(45).keys()].map((i) => i + 1));
  });

  it('filter by substring; validation of filter, limit and cursor', async () => {
    const s = await start();
    const f = await s.req('GET', '/api/items?filter=299');
    expect(f.body.items.map((i: { id: number }) => i.id)).toEqual(
      [...Array(3000).keys()].map((i) => i + 1).filter((id) => String(id).includes('299')),
    );
    expect(f.body.done).toBe(true);
    for (const bad of [
      'filter=1a',
      'filter=-1',
      'filter=%201',
      `filter=${'1'.repeat(17)}`,
      'limit=abc',
    ]) {
      const r = await s.req('GET', `/api/items?${bad}`);
      expect(r.status, bad).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await s.req('GET', '/api/items?cursor=@@@')).body.error.code).toBe('INVALID_CURSOR');
    expect((await s.req('GET', '/api/items?cursor=e30')).body.error.code).toBe('INVALID_CURSOR');
    const page = await s.req('GET', '/api/items?filter=1&limit=2');
    const other = await s.req('GET', `/api/items?filter=2&cursor=${page.body.nextCursor}`);
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe('CURSOR_MISMATCH');
    const wrongList = await s.req('GET', `/api/selected?filter=1&cursor=${page.body.nextCursor}`);
    expect(wrongList.body.error.code).toBe('CURSOR_MISMATCH');
  });

  it('health and unknown routes', async () => {
    const s = await start();
    const h = await s.req('GET', '/api/health');
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ status: 'ok', version: 0, queues: { main: 0, add: 0 } });
    expect((await s.req('GET', '/api/nope')).body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('T14: an aborted read is not executed', async () => {
    const spy = vi.fn();
    const s = await start({ MAIN_TICK_MS: '300' }, { faults: { beforeRead: spy } });
    const controller = new AbortController();
    const p = fetch(`${s.base}/api/items?filter=77`, { signal: controller.signal }).catch(
      () => null,
    );
    await sleep(50);
    controller.abort();
    await p;
    await sleep(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('mutations', () => {
  it('select, reorder, deselect and read back the order', async () => {
    const s = await start();
    for (const id of [5, 6, 7]) {
      const r = await s.req('POST', '/api/selected', { body: { id } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id, changed: true, epoch: 0 });
    }
    const again = await s.req('POST', '/api/selected', { body: { id: 5 } });
    expect(again.body.changed).toBe(false);
    const moved = await s.req('PATCH', '/api/selected/order', {
      body: { id: 7, afterId: null, beforeId: 5 },
    });
    expect(moved.status).toBe(200);
    const first = await s.req('PATCH', '/api/selected/order', {
      body: { id: 6, position: 'first' },
    });
    expect(first.body.changed).toBe(true);
    const list = await s.req('GET', '/api/selected');
    expect(list.body.items.map((i: { id: number }) => i.id)).toEqual([6, 7, 5]);
    expect(list.body.counts).toEqual({ all: 3000, selected: 3 });
    const del = await s.req('DELETE', '/api/selected/7');
    expect(del.body).toMatchObject({ id: 7, changed: true, counts: { selected: 2 } });
    const left = await s.req('GET', '/api/items?filter=7&limit=1');
    expect(left.body.items).toEqual([{ id: 7, custom: false }]);
  });

  it('validation errors are immediate 400s', async () => {
    const s = await start();
    for (const body of [
      { id: 0 },
      { id: -1 },
      { id: 1.5 },
      { id: '5' },
      { id: 2 ** 53 },
      {},
      { id: 1, x: 1 },
    ]) {
      const r = await s.req('POST', '/api/items', { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await s.req('POST', '/api/selected', { raw: '{bad' })).body.error.code).toBe(
      'VALIDATION_ERROR',
    );
    expect((await s.req('DELETE', '/api/selected/abc')).status).toBe(400);
    expect((await s.req('DELETE', '/api/selected/0')).status).toBe(400);
    const anchors = await s.req('PATCH', '/api/selected/order', { body: { id: 1, afterId: 1 } });
    expect(anchors.body.error.code).toBe('INVALID_ANCHOR');
    const none = await s.req('PATCH', '/api/selected/order', { body: { id: 1 } });
    expect(none.body.error.code).toBe('INVALID_ANCHOR');
    const mixed = await s.req('PATCH', '/api/selected/order', {
      body: { id: 1, afterId: 2, position: 'last' },
    });
    expect(mixed.body.error.code).toBe('INVALID_ANCHOR');
    const badKey = await s.req('POST', '/api/selected', { body: { id: 1 }, key: 'short' });
    expect(badKey.status).toBe(400);
    expect(s.runtime.store.version).toBe(0);
  });

  it('domain errors: 404, 409 NOT_SELECTED / ANCHOR_NOT_FOUND / ORDER_CONFLICT', async () => {
    const s = await start();
    expect((await s.req('POST', '/api/selected', { body: { id: 999_999 } })).status).toBe(404);
    expect((await s.req('DELETE', '/api/selected/999999')).status).toBe(404);
    const ns = await s.req('PATCH', '/api/selected/order', { body: { id: 1, position: 'first' } });
    expect(ns.body.error.code).toBe('NOT_SELECTED');
    await s.req('POST', '/api/selected', { body: { id: 1 } });
    await s.req('POST', '/api/selected', { body: { id: 2 } });
    await s.req('POST', '/api/selected', { body: { id: 3 } });
    const missing = await s.req('PATCH', '/api/selected/order', { body: { id: 1, afterId: 50 } });
    expect(missing.body.error.code).toBe('ANCHOR_NOT_FOUND');
    const conflict = await s.req('PATCH', '/api/selected/order', {
      body: { id: 1, afterId: 3, beforeId: 2 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('ORDER_CONFLICT');
  });

  it('add: 201 after the ADD phase; existing ID → 409 immediately; pending select → ITEM_PENDING', async () => {
    const s = await start({ MAIN_TICK_MS: '50', ADD_EVERY_TICKS: '10' });
    const t0 = Date.now();
    const exists = await s.req('POST', '/api/items', { body: { id: 10 } });
    expect(exists.status).toBe(409);
    expect(exists.body.error.details.reason).toBe('exists');
    expect(Date.now() - t0).toBeLessThan(100);
    const add = s.req('POST', '/api/items', { body: { id: 1_000_000_123 } });
    await sleep(20);
    const pendingSelect = await s.req('POST', '/api/selected', { body: { id: 1_000_000_123 } });
    expect(pendingSelect.body.error.code).toBe('ITEM_PENDING');
    expect(pendingSelect.headers.get('retry-after')).toBeTruthy();
    const added = await add;
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      item: { id: 1_000_000_123, custom: true },
      counts: { all: 3001 },
    });
    const dup = await s.req('POST', '/api/items', { body: { id: 1_000_000_123 } });
    expect(dup.body.error.details.reason).toBe('exists');
    const sel = await s.req('POST', '/api/selected', { body: { id: 1_000_000_123 } });
    expect(sel.status).toBe(200);
    const left = await s.req('GET', '/api/items?filter=1000000123');
    expect(left.body.items.map((i: { id: number }) => i.id)).toEqual([]);
  });

  it('custom ID limit → 422', async () => {
    const s = await start({ MAX_CUSTOM_IDS: '1' });
    void s.req('POST', '/api/items', { body: { id: 5000 } });
    await sleep(10);
    const r = await s.req('POST', '/api/items', { body: { id: 5001 } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CUSTOM_LIMIT_REACHED');
  });
});

describe('idempotency over HTTP', () => {
  it('T9: same key and body → same response with Idempotent-Replayed; state unchanged', async () => {
    const s = await start();
    const a = await s.req('POST', '/api/selected', { body: { id: 9 }, key: 'key-t9-0001' });
    const v = s.runtime.store.version;
    const b = await s.req('POST', '/api/selected', { body: { id: 9 }, key: 'key-t9-0001' });
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect(a.headers.get('idempotent-replayed')).toBeNull();
    expect(s.runtime.store.version).toBe(v);
  });

  it('T10: same key, different body → 422 IDEMPOTENCY_KEY_REUSED, nothing executed', async () => {
    const s = await start();
    await s.req('POST', '/api/selected', { body: { id: 9 }, key: 'key-t10-001' });
    const r = await s.req('POST', '/api/selected', { body: { id: 10 }, key: 'key-t10-001' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(s.runtime.store.isSelected(10)).toBe(false);
    const d = await s.req('DELETE', '/api/selected/9', { key: 'key-t10-001' });
    expect(d.status).toBe(422);
  });

  it('T24: 500 INTERNAL is not stored — a retry with the same key executes and succeeds', async () => {
    let failNext = true;
    const s = await start(
      {},
      {
        faults: {
          beforePrepare: () => {
            if (failNext) {
              failNext = false;
              throw new Error('injected');
            }
          },
        },
      },
    );
    const before = s.runtime.store.digest();
    const a = await s.req('POST', '/api/selected', { body: { id: 4 }, key: 'key-t24-001' });
    expect(a.status).toBe(500);
    expect(a.body.error.code).toBe('INTERNAL');
    expect(s.runtime.store.digest()).toBe(before);
    const b = await s.req('POST', '/api/selected', { body: { id: 4 }, key: 'key-t24-001' });
    expect(b.status).toBe(200);
    expect(b.headers.get('idempotent-replayed')).toBeNull();
  });

  it('T25b: OUTCOME_UNKNOWN is stored; replay does not touch the store; process exits with 1', async () => {
    const exit = vi.fn();
    const prepare = vi.fn();
    const s = await start(
      {},
      {
        exit,
        faults: {
          beforePrepare: prepare,
          beforeWrite: (i: number) => {
            if (i === 1) throw new Error('commit');
          },
          beforeUndo: () => {
            throw new Error('undo');
          },
        },
      },
    );
    const queued = s.req('GET', '/api/items?filter=5');
    const a = await s.req('POST', '/api/selected', { body: { id: 4 }, key: 'key-t25b-01' });
    expect(a.status).toBe(500);
    expect(a.body.error.code).toBe('OUTCOME_UNKNOWN');
    const b = await s
      .req('POST', '/api/selected', { body: { id: 4 }, key: 'key-t25b-01' })
      .catch(() => null);
    if (b) {
      expect(b.body).toEqual(a.body);
      expect(b.headers.get('idempotent-replayed')).toBe('true');
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    const q = await queued.catch(() => null);
    if (q) expect([200, 503]).toContain(q.status);
    for (let i = 0; i < 100 && exit.mock.calls.length === 0; i++) await sleep(20);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('T25d: respond fails → the operation is applied; retry with the key returns success', async () => {
    let failRespond = true;
    const s = await start(
      {},
      {
        beforeRespond: (req: { method: string }) => {
          if (failRespond && req.method === 'POST') {
            failRespond = false;
            throw new Error('socket gone');
          }
        },
      },
    );
    const a = await s
      .req('POST', '/api/selected', { body: { id: 8 }, key: 'key-t25d-01' })
      .catch((e) => e);
    expect(a).toBeInstanceOf(Error);
    expect(s.runtime.store.isSelected(8)).toBe(true);
    const log = s.runtime.store.changesSince(0, 10);
    expect(log.ok && log.changes).toEqual([
      { type: 'selected', id: 8, key: expect.any(String), v: 1 },
    ]);
    const b = await s.req('POST', '/api/selected', { body: { id: 8 }, key: 'key-t25d-01' });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ id: 8, changed: true, version: 1 });
    expect(b.headers.get('idempotent-replayed')).toBe('true');
  });
});

describe('rate limit (T22)', () => {
  it('over the limit → 429 with Retry-After; state unchanged', async () => {
    const s = await start({
      RATE_LIMIT_ENABLED: 'true',
      RATE_MUTATION_PER_SEC: '1',
      RATE_MUTATION_BURST: '2',
      RATE_READ_PER_SEC: '1',
      RATE_READ_BURST: '1',
    });
    const results = await Promise.all(
      [1, 2, 3, 4].map((id) => s.req('POST', '/api/selected', { body: { id } })),
    );
    const limited = results.filter((r) => r.status === 429);
    expect(limited).toHaveLength(2);
    for (const r of limited) {
      expect(r.body.error.code).toBe('RATE_LIMITED');
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    }
    expect(s.runtime.store.counts().selected).toBe(2);
    expect((await s.req('GET', '/api/items')).status).toBe(200);
    expect((await s.req('GET', '/api/items')).status).toBe(429);
    expect((await s.req('GET', '/api/health')).status).toBe(200);
  });
});

describe('changes and SSE', () => {
  it('/api/changes returns the log; HISTORY_EXPIRED when out of the buffer or ahead', async () => {
    const s = await start({ CHANGE_LOG_SIZE: '3' });
    for (const id of [1, 2, 3, 4, 5]) await s.req('POST', '/api/selected', { body: { id } });
    const ok = await s.req('GET', '/api/changes?since=3');
    expect(ok.body).toMatchObject({ fromVersion: 3, toVersion: 5, hasMore: false, epoch: 0 });
    expect(ok.body.changes.map((c: { v: number }) => c.v)).toEqual([4, 5]);
    expect((await s.req('GET', '/api/changes?since=1')).body.error.code).toBe('HISTORY_EXPIRED');
    expect((await s.req('GET', '/api/changes?since=6')).body.error.code).toBe('HISTORY_EXPIRED');
    expect((await s.req('GET', '/api/changes?since=x')).status).toBe(400);
    expect((await s.req('GET', '/api/changes')).status).toBe(400);
  });

  it('hello, one batch per tick, same payload as /api/changes', async () => {
    const s = await start();
    const sse = await openSse(`${s.base}/api/events`);
    expect(sse.res.headers.get('content-type')).toContain('text/event-stream');
    expect(sse.res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(sse.res.headers.get('x-accel-buffering')).toBe('no');
    expect(sse.res.headers.get('content-encoding')).toBeNull();
    const hello = await sse.waitFor((e) => e.event === 'hello');
    expect(hello.data).toMatchObject({ version: 0, epoch: 0, counts: { all: 3000, selected: 0 } });
    await Promise.all([1, 2, 3].map((id) => s.req('POST', '/api/selected', { body: { id } })));
    const batch = await sse.waitFor((e) => e.event === 'batch' && e.data.toVersion === 3);
    expect(batch.id).toBe(`${s.runtime.store.instance}.3`);
    expect(batch.data.instance).toBe(s.runtime.store.instance);
    expect(hello.data.instance).toBe(s.runtime.store.instance);
    const changes = await s.req('GET', '/api/changes?since=0');
    expect(batch.data.changes).toEqual(changes.body.changes);
    await sse.close();
  });

  it('T18: reconnect with Last-Event-ID replays missed changes; outside the buffer → resync', async () => {
    const s = await start({ CHANGE_LOG_SIZE: '5' });
    for (const id of [1, 2, 3]) await s.req('POST', '/api/selected', { body: { id } });
    const replay = await openSse(`${s.base}/api/events`, { 'Last-Event-ID': '1' });
    const b = await replay.waitFor((e) => e.event === 'batch');
    expect(b.data.fromVersion).toBe(1);
    expect(b.data.changes.map((c: { v: number }) => c.v)).toEqual([2, 3]);
    await replay.close();
    const viaQuery = await openSse(`${s.base}/api/events?lastEventId=2`);
    expect((await viaQuery.waitFor((e) => e.event === 'batch')).data.changes).toHaveLength(1);
    await viaQuery.close();
    for (const id of [4, 5, 6, 7, 8, 9]) await s.req('POST', '/api/selected', { body: { id } });
    const old = await openSse(`${s.base}/api/events`, { 'Last-Event-ID': '1' });
    const r = await old.waitFor((e) => e.event === 'resync');
    expect(r.data.reason).toBe('history_expired');
    await old.close();
    const ahead = await openSse(`${s.base}/api/events`, { 'Last-Event-ID': '500' });
    expect((await ahead.waitFor((e) => e.event === 'resync')).data.reason).toBe('version_ahead');
    await ahead.close();
  });

  it('T32: a restarted server (new instance) never continues an old history, even when ahead', async () => {
    const old = await start();
    for (const id of [1, 2]) await old.req('POST', '/api/selected', { body: { id } });
    const oldInstance = old.runtime.store.instance;
    await old.close();
    server = null;
    const s = await start();
    const instance = s.runtime.store.instance;
    expect(instance).not.toBe(oldInstance);
    for (const id of [10, 11, 12, 13]) await s.req('POST', '/api/selected', { body: { id } });
    expect(s.runtime.store.version).toBe(4);

    const health = await s.req('GET', '/api/health');
    expect(health.body.instance).toBe(instance);
    const page = await s.req('GET', '/api/selected');
    expect(page.body.instance).toBe(instance);
    const sel = await s.req('POST', '/api/selected', { body: { id: 14 } });
    expect(sel.body.instance).toBe(instance);

    const sse = await openSse(`${s.base}/api/events`, { 'Last-Event-ID': `${oldInstance}.2` });
    const hello = await sse.waitFor((e) => e.event === 'hello');
    expect(hello.data.instance).toBe(instance);
    const r = await sse.waitFor((e) => e.event === 'resync');
    expect(r.data).toMatchObject({ reason: 'instance_changed', instance, version: 5 });
    expect(r.id).toBe(`${instance}.5`);
    await sleep(50);
    expect(sse.events.filter((e) => e.event === 'batch')).toEqual([]);
    await sse.close();
    const q = await openSse(`${s.base}/api/events?lastEventId=${oldInstance}.2`);
    expect((await q.waitFor((e) => e.event === 'resync')).data.reason).toBe('instance_changed');
    await q.close();
    const own = await openSse(`${s.base}/api/events?lastEventId=${instance}.3`);
    const b = await own.waitFor((e) => e.event === 'batch');
    expect(b.data.changes.map((c: { v: number }) => c.v)).toEqual([4, 5]);
    await own.close();

    const stale = await s.req('GET', `/api/changes?since=2&instance=${oldInstance}`);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'HISTORY_EXPIRED',
      details: { reason: 'instance_changed', instance, currentVersion: 5, epoch: 0 },
    });
    const same = await s.req('GET', `/api/changes?since=2&instance=${instance}`);
    expect(same.body).toMatchObject({ fromVersion: 2, toVersion: 5, instance });
    expect((await s.req('GET', '/api/changes?since=2&instance=bad.id')).status).toBe(400);
  });

  it('T17: local re-key → ordinary batch, no resync, old cursors keep working', async () => {
    const s = await start({ KEY_MAX_LEN: '8' });
    for (const id of [1, 2, 3, 4]) await s.req('POST', '/api/selected', { body: { id } });
    const page = await s.req('GET', '/api/selected?limit=2');
    const sse = await openSse(`${s.base}/api/events`);
    await sse.waitFor((e) => e.event === 'hello');
    for (let i = 0; i < 40; i++) {
      await s.req('PATCH', '/api/selected/order', { body: { id: (i % 2) + 2, afterId: 1 } });
    }
    expect(s.runtime.store.epoch).toBe(0);
    const v = s.runtime.store.version;
    expect(v).toBeGreaterThanOrEqual(44);
    await sse.waitFor((e) => e.event === 'batch' && e.data.toVersion === v);
    expect(sse.events.some((e) => e.event === 'resync')).toBe(false);
    const next = await s.req('GET', `/api/selected?cursor=${page.body.nextCursor}`);
    expect(next.status).toBe(200);
    const changes = await s.req('GET', '/api/changes?since=4');
    expect(changes.body.changes).toHaveLength(v - 4);
    await sse.close();
  });

  it('T17: global rebalance (fallback) → resync event and CURSOR_EXPIRED for old cursors', async () => {
    const s = await start({ KEY_MAX_LEN: '8', REKEY_MAX_SIDE: '0' });
    for (const id of [1, 2, 3, 4]) await s.req('POST', '/api/selected', { body: { id } });
    const page = await s.req('GET', '/api/selected?limit=2');
    const sse = await openSse(`${s.base}/api/events`);
    await sse.waitFor((e) => e.event === 'hello');
    for (let i = 0; i < 40 && s.runtime.store.epoch === 0; i++) {
      await s.req('PATCH', '/api/selected/order', { body: { id: (i % 2) + 2, afterId: 1 } });
    }
    expect(s.runtime.store.epoch).toBe(1);
    const resync = await sse.waitFor((e) => e.event === 'resync');
    expect(resync.data).toMatchObject({ epoch: 1, reason: 'rebalance' });
    const stale = await s.req('GET', `/api/selected?cursor=${page.body.nextCursor}`);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CURSOR_EXPIRED');
    const late = await openSse(`${s.base}/api/events`, { 'Last-Event-ID': '4' });
    expect((await late.waitFor((e) => e.event === 'resync')).data.reason).toBe('rebalance');
    await late.close();
    await sse.close();
  });

  it('per-IP SSE limit → 503; heartbeat comments are sent', async () => {
    const s = await start({ SSE_MAX_PER_IP: '2', SSE_HEARTBEAT_MS: '100' });
    const a = await openSse(`${s.base}/api/events`);
    const b = await openSse(`${s.base}/api/events`);
    const c = await fetch(`${s.base}/api/events`);
    expect(c.status).toBe(503);
    expect(((await c.json()) as any).error.code).toBe('SSE_LIMIT');
    await sleep(350);
    expect(a.comments).toBeGreaterThanOrEqual(2);
    await a.close();
    await sleep(30);
    const d = await openSse(`${s.base}/api/events`);
    expect(d.res.status).toBe(200);
    await b.close();
    await d.close();
  });

  it('T13 over HTTP: shutdown answers queued requests with 503 and sends `shutdown` over SSE', async () => {
    const s = await start({ MAIN_TICK_MS: '1000' });
    const sse = await openSse(`${s.base}/api/events`);
    await sse.waitFor((e) => e.event === 'hello');
    const pending = [
      s.req('POST', '/api/selected', { body: { id: 1 } }),
      s.req('GET', '/api/items'),
      s.req('POST', '/api/items', { body: { id: 7_000_000 } }),
    ];
    await sleep(50);
    const t0 = Date.now();
    await s.close();
    const results = await Promise.all(pending);
    expect(Date.now() - t0).toBeLessThan(1000);
    for (const r of results) {
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('SHUTTING_DOWN');
    }
    expect((await sse.waitFor((e) => e.event === 'shutdown')).data.reason).toBe('shutdown');
    expect(s.runtime.store.version).toBe(0);
    server = null;
    await sse.close();
  });
});
