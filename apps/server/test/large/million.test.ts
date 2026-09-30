import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../../src/core/clock.js';
import { decodeCursor } from '../../src/core/cursor.js';
import { Engine, type ReadRequest } from '../../src/core/engine.js';
import { Store } from '../../src/store/store.js';
import { engineDefaults, silentLogger } from '../helpers/factories.js';

const N = 1_000_000;
const S = 100_000;

function millionStore(): Store {
  return new Store({ baseMax: N, maxCustomIds: 500_000, keyMaxLen: 128, changeLogSize: 10_000 });
}

function shuffled(n: number, seed = 42): number[] {
  const a = Array.from({ length: n }, (_, i) => i + 1);
  let x = seed;
  for (let i = n - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe('million-scale data (T15)', () => {
  const store = millionStore();
  const order = shuffled(N);
  const t0 = performance.now();
  store.loadSelectedFixture(order);
  const buildMs = performance.now() - t0;

  it('fixture: 1M selected in shuffled order, invariants hold', () => {
    console.log(
      `fixture built in ${buildMs.toFixed(0)} ms, heap ${(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0)} MB`,
    );
    expect(store.counts()).toEqual({ all: N, selected: N });
    const t = performance.now();
    store.assertInvariants();
    console.log(`assertInvariants: ${(performance.now() - t).toFixed(0)} ms`);
  });

  for (const filter of ['999999', '1234567', '9007199254740991', '77777']) {
    it(`right list, filter "${filter}": each request scans ≤ S, done within ⌈n/S⌉ requests, no gaps`, () => {
      const expected = order.filter((id) => String(id).includes(filter));
      const got: number[] = [];
      let pos: string | null = null;
      let requests = 0;
      let maxMs = 0;
      for (;;) {
        const t = performance.now();
        const r = store.readRight(filter, pos, 20, S);
        maxMs = Math.max(maxMs, performance.now() - t);
        requests++;
        expect(r.scanned).toBeLessThanOrEqual(S);
        got.push(...r.items.map((i) => i.id));
        if (r.done) break;
        pos = r.nextPos;
      }
      console.log(`filter ${filter}: ${requests} requests, max ${maxMs.toFixed(1)} ms/request`);
      expect(got).toEqual(expected);
      expect(requests).toBeLessThanOrEqual(Math.ceil(N / S) + Math.ceil(expected.length / 20));
    });
  }

  it('right list, filter "1": first pages are fast and bounded', () => {
    let pos: string | null = null;
    const got: number[] = [];
    for (let i = 0; i < 50; i++) {
      const r = store.readRight('1', pos, 20, S);
      expect(r.scanned).toBeLessThanOrEqual(S);
      got.push(...r.items.map((x) => x.id));
      pos = r.nextPos;
    }
    expect(got).toEqual(order.filter((id) => String(id).includes('1')).slice(0, 1000));
  });

  it('left list with everything selected: empty in one request (block skipping)', () => {
    for (const filter of ['', '1', '999999']) {
      const t = performance.now();
      const r = store.readLeft(filter, 0, 20, S);
      expect(r.done).toBe(true);
      expect(r.items).toEqual([]);
      expect(performance.now() - t).toBeLessThan(200);
    }
  });

  it('left list, half selected: filtered walks match brute force', () => {
    const half = millionStore();
    half.loadSelectedFixture(order.slice(0, N / 2));
    const selected = new Set(order.slice(0, N / 2));
    for (const filter of ['999999', '1234', '50000', '0000']) {
      const expected: number[] = [];
      for (let id = 1; id <= N; id++)
        if (!selected.has(id) && String(id).includes(filter)) expected.push(id);
      const got: number[] = [];
      let pos = 0;
      for (;;) {
        const r = half.readLeft(filter, pos, 20, S);
        expect(r.scanned).toBeLessThanOrEqual(S);
        got.push(...r.items.map((i) => i.id));
        if (r.done) break;
        pos = r.nextPos!;
      }
      expect(got, filter).toEqual(expected);
    }
    const first = half.readLeft('', 0, 20, S);
    const exp: number[] = [];
    for (let id = 1; exp.length < 20; id++) if (!selected.has(id)) exp.push(id);
    expect(first.items.map((i) => i.id)).toEqual(exp);
  });

  it('event loop p99 delay < 50 ms while the engine serves heavy filtered reads', async () => {
    const engine = new Engine(
      store,
      { ...engineDefaults, mainTickMs: 50, checkInvariants: false },
      systemClock,
      {
        logger: silentLogger,
      },
    );
    engine.start();
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    const reads: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      const req: ReadRequest = {
        kind: 'selected',
        filter: String(10_000 + i * 7919),
        pos: null,
        epoch: null,
        limit: 20,
      };
      reads.push(
        engine.submitRead(req).promise.then(async (r) => {
          expect(r.status).toBe(200);
          const body = r.body as { nextCursor: string | null; scanned: number };
          expect(body.scanned).toBeLessThanOrEqual(S);
          if (body.nextCursor)
            decodeCursor(body.nextCursor, 'selected', req.kind === 'selected' ? req.filter : '');
        }),
      );
    }
    await Promise.all(reads);
    h.disable();
    await engine.shutdown();
    const p99 = h.percentile(99) / 1e6;
    console.log(
      `event loop delay p99 = ${p99.toFixed(1)} ms, max = ${(h.max / 1e6).toFixed(1)} ms`,
    );
    expect(p99).toBeLessThan(50);
  });

  it('T17 at 1M: 20 000 moves into one spot re-key locally — no epoch change, bounded time', () => {
    const anchor = order[N / 2]!;
    const heap0 = process.memoryUsage().heapUsed;
    const v0 = store.version;
    let maxMs = 0;
    let rekeys = 0;
    let entries = 0;
    for (let i = 0; i < 20_000; i++) {
      const id = order[i]!;
      if (id === anchor) continue;
      const t = performance.now();
      const p = store.prepareReorder({ id, afterId: anchor });
      if (!p.ok) throw p.error;
      store.commit(p.plan, []);
      maxMs = Math.max(maxMs, performance.now() - t);
      expect(p.plan.rebalanced).toBe(false);
      if (p.plan.changes.length > 1) rekeys++;
      entries += p.plan.changes.length;
    }
    const heapMB = (process.memoryUsage().heapUsed - heap0) / 2 ** 20;
    console.log(
      `20 000 moves into one spot: ${rekeys} local re-keys, max ${maxMs.toFixed(1)} ms/op, heap +${heapMB.toFixed(0)} MB`,
    );
    expect(rekeys).toBeGreaterThan(0);
    expect(store.epoch).toBe(0);
    expect(store.version - v0).toBe(entries);
    expect(maxMs).toBeLessThan(100);
    const after = store.orderTree.nextHigherKey(store.keyOf(anchor)!)!;
    expect(store.orderTree.get(after)).toBe(
      order[19_999] === anchor ? order[19_998] : order[19_999],
    );
    store.assertInvariants();
  });
});
