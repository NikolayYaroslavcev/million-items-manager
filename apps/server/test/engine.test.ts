import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { BatchPublication, MutationInput } from '../src/core/engine.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import { resultCode, type OpResult } from '../src/errors.js';
import { makeEngine, makeStore } from './helpers/factories.js';
import { ReferenceModel } from './helpers/referenceModel.js';

type Tracked = { result?: OpResult; at?: number };

function track(promise: Promise<OpResult>, clock: { now(): number }): Tracked {
  const t: Tracked = {};
  void promise.then((r) => {
    t.result = r;
    t.at = clock.now();
  });
  return t;
}

const body = (r: OpResult) => r.body as Record<string, unknown>;

function decodeSelectedPos(cursor: string): string {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).pos as string;
}

describe('scheduler timing (T4)', () => {
  it('add at 0.1 s applies at 10 s; read at 0.2 s answers at 1 s; mutation at 0.9 s is visible to that read', async () => {
    const { engine, clock } = makeEngine();
    await clock.advanceTo(100);
    const add = track(engine.submitAdd(5_000_000), clock);
    await clock.advanceTo(200);
    const read = track(
      engine.submitRead({ kind: 'selected', filter: '', pos: null, epoch: null, limit: 20 })
        .promise,
      clock,
    );
    await clock.advanceTo(900);
    const sel = track(engine.submitMutation({ kind: 'select', id: 42 }), clock);
    await clock.advanceTo(999);
    expect(read.result).toBeUndefined();
    await clock.advanceTo(1000);
    expect(sel.at).toBe(1000);
    expect(read.at).toBe(1000);
    expect(body(read.result!).items).toEqual([{ id: 42, key: expect.any(String) }]);
    await clock.advanceTo(9999);
    expect(add.result).toBeUndefined();
    await clock.advanceTo(10_000);
    expect(add.at).toBe(10_000);
    expect(add.result!.status).toBe(201);
  });

  it('a slow batch produces one catch-up batch, not an accumulation', async () => {
    const batches: number[] = [];
    const { engine, clock } = makeEngine({
      hooks: {
        faults: {
          beforeRead: () => {
            clock.bump(3500);
          },
        },
      },
    });
    engine.onBatch(() => batches.push(clock.now()));
    void engine.submitRead({ kind: 'changes', since: 0, instance: null }).promise;
    await clock.advanceTo(1000);
    void engine.submitMutation({ kind: 'select', id: 1 });
    await clock.advance(1);
    expect(batches).toEqual([4500]);
    void engine.submitMutation({ kind: 'select', id: 2 });
    await clock.advanceTo(5000);
    expect(batches).toEqual([4500, 5000]);
  });

  it('reports the time until the next ADD phase', async () => {
    const { engine, clock } = makeEngine();
    expect(engine.nextAddInMs()).toBe(10_000);
    await clock.advanceTo(3500);
    expect(engine.nextAddInMs()).toBe(6500);
    await clock.advanceTo(10_000);
    expect(engine.nextAddInMs()).toBe(10_000);
  });
});

describe('concurrent adds (T1, T2, T3)', () => {
  it('T1: 1000 concurrent adds of one new ID without a key → exactly one 201', async () => {
    const { engine, store, clock } = makeEngine();
    const all = Array.from({ length: 1000 }, () => engine.submitAdd(7_777_777));
    await clock.advanceTo(10_000);
    const late = await Promise.all([engine.submitAdd(7_777_777)]);
    const results = [...(await Promise.all(all)), ...late];
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const conflicts = results.filter((r) => r.status === 409);
    expect(conflicts).toHaveLength(1000);
    expect(conflicts.slice(0, 999).every((r) => body(r).error)).toBe(true);
    expect(
      conflicts.map((r) => (body(r).error as { details: { reason: string } }).details.reason),
    ).toEqual([...Array(999).fill('concurrent'), 'exists']);
    expect(store.customCount).toBe(1);
    expect(store.version).toBe(1);
    store.assertInvariants();
  });

  it('T2: 1000 concurrent adds with one Idempotency-Key → all 201 with the same body', async () => {
    const { engine, store, clock } = makeEngine();
    const idem = new IdempotencyStore({ ttlMs: 600_000, maxEntries: 50_000, clock });
    const all = Array.from({ length: 1000 }, () =>
      idem.run('same-key-123', 'fp', () => engine.submitAdd(8_888_888)),
    );
    await clock.advanceTo(10_000);
    const results = await Promise.all(all);
    expect(results.every((r) => r.result.status === 201)).toBe(true);
    expect(new Set(results.map((r) => JSON.stringify(r.result.body))).size).toBe(1);
    expect(store.version).toBe(1);
  });

  it('T3: 5000 different IDs → all 201, invisible before the 10 s tick, then ascending', async () => {
    const { engine, store, clock } = makeEngine();
    const ids = fc.sample(fc.integer({ min: 3001, max: 9_000_000_000 }), 20_000);
    const unique = [...new Set(ids)].slice(0, 5000);
    const all = unique.map((id) => engine.submitAdd(id));
    await clock.advanceTo(8_999);
    expect(store.customCount).toBe(0);
    const read = engine.submitRead({ kind: 'items', filter: '', pos: 3000, limit: 20 }).promise;
    await clock.advanceTo(9_000);
    expect(body(await read).items).toEqual([]);
    await clock.advanceTo(10_000);
    const results = await Promise.all(all);
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seen: number[] = [];
    let pos = 3000;
    for (;;) {
      const r = store.readLeft('', pos, 20, 100_000);
      seen.push(...r.items.map((i) => i.id));
      if (r.done) break;
      pos = r.nextPos!;
    }
    expect(seen).toEqual([...unique].sort((a, b) => a - b));
    store.assertInvariants();
  });
});

describe('FIFO conflicts vs reference model (T5)', () => {
  it('10 000 random operations from 50 clients match sequential application', async () => {
    const { engine, store, clock } = makeEngine({
      store: makeStore({ baseMax: 200, keyMaxLen: 12 }),
    });
    const ref = new ReferenceModel(200);
    const rnd = fc.sample(
      fc.record({
        client: fc.integer({ min: 0, max: 49 }),
        kind: fc.constantFrom('select', 'deselect', 'reorder', 'first'),
        id: fc.integer({ min: 1, max: 60 }),
        a: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }),
        b: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }),
        delay: fc.integer({ min: 0, max: 400 }),
      }),
      10_000,
    );
    const submitted: { input: MutationInput; p: Promise<OpResult> }[] = [];
    for (const op of rnd) {
      await clock.advance(op.delay % 3 === 0 ? op.delay : 0);
      const input: MutationInput =
        op.kind === 'select'
          ? { kind: 'select', id: op.id }
          : op.kind === 'deselect'
            ? { kind: 'deselect', id: op.id }
            : op.kind === 'first'
              ? { kind: 'reorder', input: { id: op.id, position: 'first' } }
              : { kind: 'reorder', input: { id: op.id, afterId: op.a, beforeId: op.b } };
      submitted.push({ input, p: engine.submitMutation(input) });
    }
    await clock.advance(2000);
    for (const { input, p } of submitted) {
      const r = await p;
      const exp =
        input.kind === 'select'
          ? ref.select(input.id)
          : input.kind === 'deselect'
            ? ref.deselect(input.id)
            : ref.reorder(input.input);
      expect(resultCode(r)).toBe(exp.code);
      if (exp.changed !== undefined) expect(body(r).changed).toBe(exp.changed);
    }
    const order: number[] = [];
    for (const [, id] of store.orderTree.entries()) order.push(id);
    expect(order).toEqual(ref.selected);
    store.assertInvariants();
  });
});

describe('add then select (T26, table 3.4)', () => {
  it('select while the add is queued in a non-ADD batch → 409 ITEM_PENDING', async () => {
    const { engine, clock } = makeEngine();
    await clock.advanceTo(100);
    void engine.submitAdd(9_000_001);
    const sel = engine.submitMutation({ kind: 'select', id: 9_000_001 });
    await clock.advanceTo(1000);
    const r = await sel;
    expect(resultCode(r)).toBe('ITEM_PENDING');
    expect((body(r).error as { details: { retryAfterMs: number } }).details.retryAfterMs).toBe(
      9000,
    );
    expect(r.headers?.['Retry-After']).toBe('9');
  });

  it('add and select queued before the 10 s tick in any order → 201 and 200', async () => {
    for (const selectFirst of [true, false]) {
      const { engine, store, clock } = makeEngine();
      await clock.advanceTo(9_100);
      let sel: Promise<OpResult>;
      let add: Promise<OpResult>;
      if (selectFirst) {
        sel = engine.submitMutation({ kind: 'select', id: 9_000_002 });
        add = engine.submitAdd(9_000_002);
      } else {
        add = engine.submitAdd(9_000_002);
        sel = engine.submitMutation({ kind: 'select', id: 9_000_002 });
      }
      await clock.advanceTo(10_000);
      expect((await add).status).toBe(201);
      expect((await sel).status).toBe(200);
      expect(store.isSelected(9_000_002)).toBe(true);
    }
  });

  it('select of an ID that was never added → 404; after the add applied → 200', async () => {
    const { engine, clock } = makeEngine();
    const missing = engine.submitMutation({ kind: 'select', id: 9_000_003 });
    await clock.advanceTo(1000);
    expect(resultCode(await missing)).toBe('NOT_FOUND');
    const add = engine.submitAdd(9_000_003);
    await clock.advanceTo(10_000);
    expect((await add).status).toBe(201);
    const sel = engine.submitMutation({ kind: 'select', id: 9_000_003 });
    await clock.advanceTo(11_000);
    expect((await sel).status).toBe(200);
  });
});

describe('queues: overflow, timeouts, cancellation, dedup', () => {
  it('T12: 101st operation gets 503 QUEUE_FULL with Retry-After; accepted 100 applied', async () => {
    const { engine, store, clock } = makeEngine({ config: { mainQueueCap: 100 } });
    const accepted = Array.from({ length: 100 }, (_, i) =>
      engine.submitMutation({ kind: 'select', id: i + 1 }),
    );
    const rejected = await engine.submitMutation({ kind: 'select', id: 500 });
    expect(resultCode(rejected)).toBe('QUEUE_FULL');
    expect(rejected.status).toBe(503);
    expect(rejected.headers?.['Retry-After']).toBe('1');
    const readRejected = await engine.submitRead({ kind: 'changes', since: 0, instance: null })
      .promise;
    expect(resultCode(readRejected)).toBe('QUEUE_FULL');
    await clock.advanceTo(1000);
    expect((await Promise.all(accepted)).every((r) => r.status === 200)).toBe(true);
    expect(store.isSelected(500)).toBe(false);
    expect(store.counts().selected).toBe(100);
  });

  it('add queue overflow → 503 with Retry-After until the ADD phase; duplicates do not take slots', async () => {
    const { engine, clock } = makeEngine({ config: { addQueueCap: 2 } });
    await clock.advanceTo(2500);
    void engine.submitAdd(10_001);
    void engine.submitAdd(10_002);
    void engine.submitAdd(10_001);
    const r = await engine.submitAdd(10_003);
    expect(resultCode(r)).toBe('QUEUE_FULL');
    expect(r.headers?.['Retry-After']).toBe('8');
  });

  it('T11: timed-out operation is not applied; a retry with the same key applies once', async () => {
    const { engine, store, clock } = makeEngine({ config: { mainQueueTimeoutMs: 500 } });
    const idem = new IdempotencyStore({ ttlMs: 600_000, maxEntries: 100, clock });
    const first = idem.run('retry-key-1', 'fp', () =>
      engine.submitMutation({ kind: 'select', id: 9 }),
    );
    await clock.advanceTo(500);
    expect(resultCode((await first).result)).toBe('TIMEOUT_NOT_APPLIED');
    await clock.advanceTo(1000);
    expect(store.isSelected(9)).toBe(false);
    await clock.advanceTo(1600);
    expect(store.version).toBe(0);
    const retry = idem.run('retry-key-1', 'fp', () =>
      engine.submitMutation({ kind: 'select', id: 9 }),
    );
    await clock.advanceTo(2000);
    expect((await retry).result.status).toBe(200);
    const again = await idem.run('retry-key-1', 'fp', () => {
      throw new Error('must not execute');
    });
    expect(again.replayed).toBe(true);
    expect(store.version).toBe(1);
  });

  it('add times out after 30 s only if not applied (queue timeout > ADD interval never fires normally)', async () => {
    const { engine, clock } = makeEngine({ config: { addQueueTimeoutMs: 5000 } });
    const add = engine.submitAdd(10_010);
    const joiner = engine.submitAdd(10_010);
    await clock.advanceTo(5000);
    expect(resultCode(await add)).toBe('TIMEOUT_NOT_APPLIED');
    expect(resultCode(await joiner)).toBe('TIMEOUT_NOT_APPLIED');
    await clock.advanceTo(10_000);
    expect(engine.store.exists(10_010)).toBe(false);
  });

  it('T14: a cancelled read is not executed; a mutation whose client left is applied', async () => {
    const spy = vi.fn();
    const { engine, store, clock } = makeEngine({ hooks: { faults: { beforeRead: spy } } });
    const read = engine.submitRead({ kind: 'items', filter: '', pos: 0, limit: 20 });
    read.cancel();
    void engine.submitMutation({ kind: 'select', id: 3 });
    await clock.advanceTo(1000);
    expect(spy).not.toHaveBeenCalled();
    expect(store.isSelected(3)).toBe(true);
  });

  it('identical reads in one tick execute once; different ones separately', async () => {
    const spy = vi.fn();
    const { engine, clock } = makeEngine({ hooks: { faults: { beforeRead: spy } } });
    const req = { kind: 'items', filter: '5', pos: 0, limit: 20 } as const;
    const a = engine.submitRead(req);
    const b = engine.submitRead(req);
    const c = engine.submitRead({ ...req, filter: '6' });
    a.cancel();
    expect(engine.stats().main).toBe(2);
    await clock.advanceTo(1000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await b.promise).status).toBe(200);
    expect((await c.promise).status).toBe(200);
  });

  it('reads beyond READ_TICK_BUDGET_MS carry over to the next tick, first in line', async () => {
    const order: string[] = [];
    const { engine, clock } = makeEngine({
      hooks: {
        faults: {
          beforeRead: (r) => {
            order.push(r.kind === 'items' ? r.filter : '?');
            clock.bump(100);
          },
        },
      },
    });
    const reads = ['1', '2', '3', '4', '5'].map(
      (f) => engine.submitRead({ kind: 'items', filter: f, pos: 0, limit: 1 }).promise,
    );
    await clock.advanceTo(1000);
    expect(order).toEqual(['1', '2', '3']);
    void engine.submitRead({ kind: 'items', filter: '9', pos: 0, limit: 1 }).promise;
    await clock.advanceTo(2000);
    expect(order).toEqual(['1', '2', '3', '4', '5', '9']);
    expect((await Promise.all(reads)).every((r) => r.status === 200)).toBe(true);
  });

  it('read timeout → 504 and the read is dropped', async () => {
    const spy = vi.fn();
    const { engine, clock } = makeEngine({
      config: { mainQueueTimeoutMs: 400 },
      hooks: { faults: { beforeRead: spy } },
    });
    const r = engine.submitRead({ kind: 'changes', since: 0, instance: null });
    await clock.advanceTo(1000);
    expect(resultCode(await r.promise)).toBe('TIMEOUT_NOT_APPLIED');
    expect(spy).not.toHaveBeenCalled();
  });

  it('selected cursor from an older epoch → 409 CURSOR_EXPIRED; changes history errors', async () => {
    const { engine, clock } = makeEngine();
    const stale = engine.submitRead({
      kind: 'selected',
      filter: '',
      pos: 'a0',
      epoch: 5,
      limit: 20,
    });
    const ahead = engine.submitRead({ kind: 'changes', since: 10, instance: null });
    await clock.advanceTo(1000);
    expect(resultCode(await stale.promise)).toBe('CURSOR_EXPIRED');
    expect(resultCode(await ahead.promise)).toBe('HISTORY_EXPIRED');
  });
});

describe('publication', () => {
  it('one batch event per batch with all changes; none for no-ops', async () => {
    const { engine, clock } = makeEngine();
    const events: BatchPublication[] = [];
    engine.onBatch((b) => events.push(b));
    void engine.submitMutation({ kind: 'select', id: 1 });
    void engine.submitMutation({ kind: 'select', id: 2 });
    void engine.submitMutation({ kind: 'select', id: 2 });
    await clock.advanceTo(1000);
    void engine.submitMutation({ kind: 'deselect', id: 77 });
    await clock.advanceTo(2000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromVersion: 0, toVersion: 2, rebalanced: false });
    expect(events[0]!.changes.map((c) => c.id)).toEqual([1, 2]);
  });

  it('T17: global rebalance (fallback) publishes rebalanced=true and old selected cursors expire', async () => {
    const { engine, store, clock } = makeEngine({
      store: makeStore({ baseMax: 100, keyMaxLen: 8, rekeyMaxSide: 0 }),
    });
    const events: BatchPublication[] = [];
    engine.onBatch((b) => events.push(b));
    for (let id = 1; id <= 5; id++) void engine.submitMutation({ kind: 'select', id });
    await clock.advanceTo(1000);
    const page = engine.submitRead({
      kind: 'selected',
      filter: '',
      pos: null,
      epoch: null,
      limit: 2,
    }).promise;
    await clock.advanceTo(2000);
    const cursorEpoch = (body(await page) as { epoch: number }).epoch;
    for (let i = 0; i < 60; i++) {
      void engine.submitMutation({ kind: 'reorder', input: { id: (i % 2) + 2, afterId: 1 } });
    }
    await clock.advanceTo(3000);
    expect(store.epoch).toBeGreaterThan(cursorEpoch);
    expect(events.some((e) => e.rebalanced)).toBe(true);
    const stale = engine.submitRead({
      kind: 'selected',
      filter: '',
      pos: 'a1',
      epoch: cursorEpoch,
      limit: 2,
    });
    await clock.advanceTo(4000);
    expect(resultCode(await stale.promise)).toBe('CURSOR_EXPIRED');
  });

  it('T17: local re-key publishes ordinary moved changes, keeps the epoch and old cursors', async () => {
    const { engine, store, clock } = makeEngine({
      store: makeStore({ baseMax: 100, keyMaxLen: 8 }),
    });
    const events: BatchPublication[] = [];
    engine.onBatch((b) => events.push(b));
    for (let id = 1; id <= 5; id++) void engine.submitMutation({ kind: 'select', id });
    await clock.advanceTo(1000);
    const page = engine.submitRead({
      kind: 'selected',
      filter: '',
      pos: null,
      epoch: null,
      limit: 2,
    }).promise;
    await clock.advanceTo(2000);
    const first = body(await page) as { nextCursor: string; epoch: number };
    const results: Promise<OpResult>[] = [];
    for (let i = 0; i < 60; i++) {
      results.push(
        engine.submitMutation({ kind: 'reorder', input: { id: (i % 2) + 2, afterId: 1 } }),
      );
    }
    await clock.advanceTo(3000);
    expect(store.epoch).toBe(0);
    expect(events.every((e) => !e.rebalanced)).toBe(true);
    const batch = events.at(-1)!;
    expect(batch.changes.length).toBeGreaterThanOrEqual(60);
    for (const [key] of store.orderTree.entries()) expect(key.length).toBeLessThanOrEqual(8);
    expect(batch.toVersion - batch.fromVersion).toBe(batch.changes.length);
    const answers = (await Promise.all(results)).map(
      (r) => body(r) as { version: number; changed: boolean },
    );
    for (const { version: v } of answers.filter((a) => a.changed)) {
      const c = batch.changes.find((x) => x.v === v)!;
      expect(c.type).toBe('moved');
    }
    const next = engine.submitRead({
      kind: 'selected',
      filter: '',
      pos: decodeSelectedPos(first.nextCursor),
      epoch: first.epoch,
      limit: 20,
    });
    await clock.advanceTo(4000);
    expect((await next.promise).status).toBe(200);
  });
});

describe('shutdown (T13)', () => {
  it('500 queued operations get 503 SHUTTING_DOWN at once; the running batch completes', async () => {
    const { engine, store, clock } = makeEngine();
    void engine.submitMutation({ kind: 'select', id: 1 });
    const inBatch = [1, 2, 3].map(
      (i) => engine.submitRead({ kind: 'items', filter: String(i), pos: 0, limit: 1 }).promise,
    );
    clock.runNextTimer();
    const pending: Promise<OpResult>[] = [];
    for (let i = 0; i < 250; i++)
      pending.push(engine.submitMutation({ kind: 'select', id: 100 + i }));
    for (let i = 0; i < 200; i++) {
      pending.push(
        engine.submitRead({ kind: 'items', filter: String(1000 + i), pos: 0, limit: 1 }).promise,
      );
    }
    for (let i = 0; i < 50; i++) pending.push(engine.submitAdd(20_000 + i));
    const t0 = clock.now();
    await engine.shutdown();
    const results = await Promise.all(pending);
    expect(clock.now() - t0).toBeLessThan(1000);
    expect(results.every((r) => resultCode(r) === 'SHUTTING_DOWN')).toBe(true);
    expect((await Promise.all(inBatch)).every((r) => r.status === 200)).toBe(true);
    expect(store.isSelected(1)).toBe(true);
    expect(store.counts().selected).toBe(1);
    expect(store.customCount).toBe(0);
    store.assertInvariants();
    expect(resultCode(await engine.submitMutation({ kind: 'select', id: 2 }))).toBe(
      'SHUTTING_DOWN',
    );
  });
});
