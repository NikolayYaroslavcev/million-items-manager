import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/http.js';
import { SyncEngine, type Notice } from '../src/sync/engine.js';
import { leftView, rightView, type OpInput, type PendingOp } from '../src/sync/overlay.js';
import { FakeApi } from './helpers/fakeApi.js';
import { ModelServer } from './helpers/model.js';

const NO_TIMERS = {
  pageCatchUpMs: 1e9,
  pageWaitMs: 1e9,
  confirmCatchUpMs: 1e9,
};

function setup(baseMax = 100, opts: { auto?: boolean; timing?: object } = {}) {
  const server = new ModelServer(baseMax);
  const api = new FakeApi(server);
  api.auto = opts.auto ?? true;
  const notices: Notice[] = [];
  const engine = new SyncEngine({
    api: api.asApi(),
    notify: (n) => notices.push(n),
    timing: { ...NO_TIMERS, ...opts.timing },
  });
  let sent = 0;
  const hello = () => {
    sent = server.version;
    engine.receive({
      t: 'hello',
      data: {
        instance: server.instance,
        version: server.version,
        epoch: server.epoch,
        counts: server.counts(),
        nextAddInMs: 5000,
      },
      at: Date.now(),
    });
  };
  const batch = (k = Infinity) => {
    const changes = server.log.filter((c) => c.v > sent).slice(0, k);
    if (!changes.length) return false;
    const to = changes[changes.length - 1]!.v;
    engine.receive({
      t: 'batch',
      data: {
        instance: server.instance,
        fromVersion: sent,
        toVersion: to,
        epoch: server.epoch,
        counts: server.counts(),
        changes,
      },
    });
    sent = to;
    return true;
  };
  return { server, api, engine, notices, hello, batch, sentVersion: () => sent };
}

const ids = (xs: readonly { id: number }[]) => xs.map((x) => x.id);

afterEach(() => {
  vi.useRealTimers();
});

describe('SyncEngine: loading', () => {
  it('T21: the first portion of each list has at most 20 items; loadMore adds the next ≤ 20', async () => {
    const { server, api, engine, hello } = setup(100);
    for (let id = 1; id <= 30; id++) server.select(id);
    hello();
    engine.start();
    await api.flush();
    expect(engine.left.mirror.items).toHaveLength(20);
    expect(ids(engine.left.mirror.items)).toEqual(Array.from({ length: 20 }, (_, i) => 31 + i));
    expect(engine.right.mirror.items).toHaveLength(20);
    engine.loadMore('selected');
    await api.flush();
    expect(ids(engine.right.mirror.items)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(engine.right.mirror.done).toBe(true);
    engine.loadMore('items');
    await api.flush();
    expect(engine.left.mirror.items).toHaveLength(40);
  });

  it('continues a partial portion (scan budget) and stops after 10 empty responses', async () => {
    const { api, engine, hello } = setup(300);
    api.pageBudget = 5;
    hello();
    engine.setFilter('items', '99');
    engine.start();
    await api.flush(200);
    expect(ids(engine.left.mirror.items)).toEqual([]);
    expect(engine.getSnapshot().left.status.stalled).toBe(true);
    expect(engine.getSnapshot().left.status.scanned).toBe(50);
    expect(api.log.filter((c) => c.kind === 'items').length).toBeGreaterThanOrEqual(10);
    engine.loadMore('items');
    await api.flush(400);
    expect(ids(engine.left.mirror.items)).toEqual([99]);
    expect(api.log.filter((c) => c.kind === 'items').at(-1)!.args[2]).toBe(19);
    for (let i = 0; i < 10 && !engine.left.mirror.done; i++) {
      engine.loadMore('items');
      await api.flush(400);
    }
    expect(ids(engine.left.mirror.items)).toEqual([99, 199, 299]);
    expect(engine.left.mirror.done).toBe(true);
  });

  it('a filter change drops the old window and in-flight pages of the old filter', async () => {
    const { api, engine, hello } = setup(100, { auto: false });
    hello();
    engine.start();
    const stale = api.calls.find((c) => c.kind === 'items')!;
    engine.setFilter('items', '7');
    api.deliver(stale);
    await api.flush();
    expect(ids(engine.left.mirror.items).every((id) => String(id).includes('7'))).toBe(true);
    expect(engine.left.mirror.items.length).toBeGreaterThan(0);
  });

  it('a page newer than the mirror waits for the journal, then merges (5.2)', async () => {
    const { server, api, engine, hello, batch } = setup(50, { auto: false });
    hello();
    engine.start();
    server.select(1);
    server.select(2);
    for (const c of [...api.calls]) api.deliver(c);
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.right.mirror.items).toHaveLength(0);
    expect(engine.right.waiting).not.toBeNull();
    batch();
    expect(ids(engine.right.mirror.items)).toEqual([1, 2]);
    expect(ids(engine.left.mirror.items)[0]).toBe(3);
  });
});

describe('T8: windows stay exact under concurrent changes', () => {
  type Step =
    | { t: 'mutate'; op: number; a: number; b: number }
    | { t: 'batch'; k: number }
    | { t: 'serve'; i: number }
    | { t: 'deliver'; i: number }
    | { t: 'more'; list: 'items' | 'selected' };

  const step: fc.Arbitrary<Step> = fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        t: fc.constant('mutate' as const),
        op: fc.nat(3),
        a: fc.nat(80),
        b: fc.nat(80),
      }),
    },
    {
      weight: 3,
      arbitrary: fc.record({ t: fc.constant('batch' as const), k: fc.integer({ min: 1, max: 4 }) }),
    },
    { weight: 2, arbitrary: fc.record({ t: fc.constant('serve' as const), i: fc.nat(5) }) },
    { weight: 2, arbitrary: fc.record({ t: fc.constant('deliver' as const), i: fc.nat(5) }) },
    {
      weight: 2,
      arbitrary: fc.record({
        t: fc.constant('more' as const),
        list: fc.constantFrom('items' as const, 'selected' as const),
      }),
    },
  );

  it('500 random runs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('', '1', '2'),
        fc.integer({ min: 3, max: 40 }),
        fc.array(step, { minLength: 10, maxLength: 150 }),
        async (filter, budget, steps) => {
          const { server, api, engine, hello, batch } = setup(60, { auto: false });
          api.pageBudget = budget;
          for (let id = 1; id <= 40; id += 3) server.select(id);
          hello();
          engine.setFilter('items', filter);
          engine.setFilter('selected', filter);
          engine.start();
          for (const s of steps) {
            if (s.t === 'mutate') {
              const sel = server.selected.map((x) => x.id);
              const pick = (n: number) => sel[n % Math.max(1, sel.length)];
              if (s.op === 0) server.select((s.a % 70) + 1);
              else if (s.op === 1 && sel.length) server.deselect(pick(s.a)!);
              else if (s.op === 2 && sel.length > 1) {
                const x = pick(s.a)!;
                const y = pick(s.b)!;
                if (x !== y) {
                  if (s.b % 2) server.move(x, y, null);
                  else server.move(x, null, y);
                }
              } else if (s.op === 3) server.add(2000 + s.a);
            } else if (s.t === 'batch') batch(s.k);
            else if (s.t === 'serve') {
              const c = api.calls[s.i % Math.max(1, api.calls.length)];
              if (c) api.serve(c);
            } else if (s.t === 'deliver') {
              const served = api.calls.filter((c) => c.result);
              const c = served[s.i % Math.max(1, served.length)];
              if (c) api.deliver(c);
            } else engine.loadMore(s.list);
            await Promise.resolve();
          }
          for (let i = 0; i < 100 && (api.calls.length || batch()); i++) {
            batch();
            for (const c of [...api.calls]) api.deliver(c);
            await new Promise((r) => setTimeout(r, 0));
          }
          batch();
          expect(engine.version).toBe(server.version);
          const within = <T extends { id: number }>(
            items: T[],
            end: typeof engine.left.mirror.end | typeof engine.right.mirror.end,
            pos: (x: T) => number | string,
          ) => items.filter((x) => end.kind === 'all' || (end.kind === 'pos' && pos(x) <= end.pos));
          expect(ids(engine.left.mirror.items)).toEqual(
            ids(within(server.leftAll(filter), engine.left.mirror.end, (x) => x.id)),
          );
          expect(engine.right.mirror.items).toEqual(
            within(server.rightAll(filter), engine.right.mirror.end, (x) => x.key),
          );
          for (const list of [engine.left.mirror.items, engine.right.mirror.items]) {
            expect(new Set(ids(list)).size).toBe(list.length);
          }
          engine.stop();
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('SyncEngine: mutations', () => {
  it('select is optimistic, confirmed only when the journal reaches the response version', async () => {
    const { api, engine, hello, batch } = setup(50);
    hello();
    engine.start();
    await api.flush();
    api.auto = false;
    engine.select(3);
    let snap = engine.getSnapshot();
    expect(ids(leftView(snap.left.items, snap.left.end, '', snap.ops))).not.toContain(3);
    const call = api.calls.find((c) => c.kind === 'select')!;
    api.deliver(call);
    await Promise.resolve();
    await Promise.resolve();
    snap = engine.getSnapshot();
    expect(snap.ops).toHaveLength(1);
    expect(snap.ops[0]!.state).toBe('applied');
    expect(ids(leftView(snap.left.items, snap.left.end, '', snap.ops))).not.toContain(3);
    batch();
    snap = engine.getSnapshot();
    expect(snap.ops).toHaveLength(0);
    expect(ids(snap.left.items)).not.toContain(3);
    expect(ids(snap.right.items)).toEqual([3]);
  });

  it('a 4xx rejection rolls back and tells the user', async () => {
    const { api, engine, notices, hello } = setup(50);
    hello();
    engine.start();
    await api.flush();
    engine.move(7, { afterId: 1, beforeId: null });
    await api.flush();
    expect(engine.ops).toHaveLength(0);
    expect(notices.at(-1)!.message).toMatch(/Перемещение 7.*уже не выбран/);
  });

  it('dependent operations are sent in order: move waits for select of the same ID', async () => {
    const { server, api, engine, hello, batch } = setup(50);
    hello();
    engine.start();
    await api.flush();
    server.select(1);
    batch();
    api.auto = false;
    engine.selectAt(9, { afterId: null, beforeId: 1 });
    expect(api.calls.map((c) => c.kind)).toEqual(['select']);
    api.deliver(api.calls[0]!);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls.map((c) => c.kind)).toEqual(['reorder']);
    api.deliver(api.calls[0]!);
    await new Promise((r) => setTimeout(r, 0));
    batch();
    expect(ids(engine.right.mirror.items)).toEqual([9, 1]);
    expect(engine.ops).toHaveLength(0);
  });

  it('a failed part of a gesture cancels the rest of it', async () => {
    const { api, engine, notices, hello } = setup(50);
    hello();
    engine.start();
    await api.flush();
    engine.selectAt(123456, { afterId: 1, beforeId: null });
    await api.flush();
    expect(engine.ops).toHaveLength(0);
    expect(api.log.filter((c) => c.kind === 'reorder')).toHaveLength(0);
    expect(notices).toHaveLength(1);
  });

  it('not applied / unknown outcome: rollback with a retry action that reuses the key', async () => {
    const { api, engine, notices, hello } = setup(50);
    hello();
    engine.start();
    await api.flush();
    api.mutationError = () => new ApiError(0, 'NETWORK', 'down');
    const op = engine.select(5);
    await api.flush();
    expect(engine.ops).toHaveLength(0);
    const notice = notices.at(-1)!;
    expect(notice.action?.label).toBe('Повторить');
    api.mutationError = null;
    api.auto = false;
    notice.action!.run();
    expect(engine.ops[0]!.idempotencyKey).toBe(op.idempotencyKey);
  });

  it('OUTCOME_UNKNOWN: no retry offered, operation dropped', async () => {
    const { api, engine, notices, hello } = setup(50);
    hello();
    engine.start();
    await api.flush();
    api.mutationError = () => new ApiError(500, 'OUTCOME_UNKNOWN', 'fatal');
    engine.select(5);
    await api.flush();
    expect(engine.ops).toHaveLength(0);
    expect(notices.at(-1)!.action).toBeUndefined();
  });

  it('at most 3 adds are in flight; the rest wait locally (5.8)', async () => {
    const { api, engine, hello } = setup(50);
    hello();
    engine.start();
    await api.flush();
    api.auto = false;
    for (let i = 0; i < 5; i++) engine.add(2_000_000 + i);
    expect(api.calls.filter((c) => c.kind === 'add')).toHaveLength(3);
    api.deliver(api.calls.find((c) => c.kind === 'add')!);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls.filter((c) => c.kind === 'add')).toHaveLength(3);
  });

  it('pending add is shown queued in the left view when it falls into the window', async () => {
    const { api, engine, hello } = setup(20);
    hello();
    engine.start();
    await api.flush();
    engine.loadMore('items');
    await api.flush();
    expect(engine.left.mirror.done).toBe(true);
    api.auto = false;
    engine.add(5_000_000);
    const snap = engine.getSnapshot();
    const view = leftView(snap.left.items, snap.left.end, '', snap.ops);
    expect(view.at(-1)).toMatchObject({ id: 5_000_000, queued: true, custom: true });
  });
});

describe('SyncEngine: journal gaps and resync', () => {
  it('a version gap triggers a catch-up through /api/changes', async () => {
    const { server, api, engine, hello } = setup(50);
    hello();
    engine.start();
    await api.flush();
    server.select(1);
    server.select(2);
    server.select(3);
    const last = server.log.at(-1)!;
    engine.receive({
      t: 'batch',
      data: {
        instance: server.instance,
        fromVersion: last.v - 1,
        toVersion: last.v,
        epoch: 0,
        counts: server.counts(),
        changes: [last],
      },
    });
    await api.flush();
    expect(api.log.some((c) => c.kind === 'changes')).toBe(true);
    expect(engine.version).toBe(server.version);
    expect(ids(engine.right.mirror.items)).toEqual([1, 2, 3]);
  });

  it('resync (e.g. history_expired) restarts windows at the given version', async () => {
    const { server, api, engine, notices, hello } = setup(50);
    for (let i = 1; i <= 5; i++) server.select(i);
    hello();
    engine.start();
    await api.flush();
    server.deselect(1);
    engine.receive({
      t: 'resync',
      data: { instance: server.instance, version: 6, epoch: 0, reason: 'history_expired' },
    });
    await api.flush();
    expect(engine.version).toBe(6);
    expect(ids(engine.right.mirror.items)).toEqual([2, 3, 4, 5]);
    expect(notices.some((n) => n.message === 'Список обновлён')).toBe(true);
  });

  it('HISTORY_EXPIRED on catch-up → resync from the current version', async () => {
    const { server, api, engine, hello } = setup(50);
    hello();
    engine.start();
    await api.flush();
    engine.version = server.version + 100;
    await engine.catchUp();
    await api.flush();
    expect(engine.version).toBe(server.version);
    expect(engine.stats.resyncs).toBe(1);
  });

  it('a batch with another epoch (rebalance) restarts the windows', async () => {
    const { server, api, engine, hello, batch } = setup(50);
    server.select(1);
    hello();
    engine.start();
    await api.flush();
    server.select(2);
    server.epoch = 1;
    batch();
    expect(engine.epoch).toBe(1);
    await api.flush();
    expect(ids(engine.right.mirror.items)).toEqual([1, 2]);
    expect(engine.stats.resyncs).toBe(0);
    expect(engine.getSnapshot().right.status.resetToken).toBeGreaterThan(1);
  });

  it('CURSOR_EXPIRED on a page → resync', async () => {
    const { api, engine, hello } = setup(50);
    hello();
    engine.start();
    await api.flush();
    const original = api.getSelected.bind(api);
    let fail = true;
    api.getSelected = ((...args: Parameters<typeof original>) => {
      if (fail) {
        fail = false;
        return Promise.reject(new ApiError(409, 'CURSOR_EXPIRED', 'expired'));
      }
      return original(...args);
    }) as typeof api.getSelected;
    engine.setFilter('selected', '1');
    await api.flush();
    expect(engine.stats.resyncs).toBe(1);
  });
});

describe('SyncEngine: server instance (restart detection)', () => {
  async function started() {
    const ctx = setup(50);
    for (let i = 1; i <= 5; i++) ctx.server.select(i);
    ctx.hello();
    ctx.engine.start();
    await ctx.api.flush();
    expect(ctx.engine.version).toBe(5);
    return { ...ctx, oldInstance: ctx.server.instance };
  }

  it('T32: the restarted server is AHEAD of the client — its history is not taken as a continuation', async () => {
    const { server, api, engine, notices, hello, oldInstance } = await started();
    server.restart();
    for (const id of [40, 41, 42, 43, 44, 45, 46, 47]) server.select(id);
    hello();
    expect(engine.instance).toBe(server.instance);
    expect(engine.instance).not.toBe(oldInstance);
    expect(engine.stats.instanceChanges).toBe(1);
    await api.flush();
    expect(engine.version).toBe(8);
    expect(ids(engine.right.mirror.items)).toEqual([40, 41, 42, 43, 44, 45, 46, 47]);
    expect(ids(engine.left.mirror.items).slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(engine.counts).toEqual({ all: 50, selected: 8 });
    expect(notices.some((n) => n.message.startsWith('Сервер перезапущен'))).toBe(true);
    const resyncs = engine.stats.resyncs;
    engine.receive({
      t: 'resync',
      data: { instance: server.instance, version: 8, epoch: 0, reason: 'instance_changed' },
    });
    expect(engine.stats.resyncs).toBe(resyncs);
  });

  it('T32: restart with the SAME version number is detected too', async () => {
    const { server, api, engine, hello } = await started();
    server.restart();
    for (const id of [40, 41, 42, 43, 44]) server.select(id);
    hello();
    await api.flush();
    expect(ids(engine.right.mirror.items)).toEqual([40, 41, 42, 43, 44]);
  });

  it('a batch (polling / catch-up) of a new instance switches without applying its changes', async () => {
    const { server, api, engine, oldInstance } = await started();
    server.restart();
    for (const id of [40, 41, 42, 43, 44, 45, 46]) server.select(id);
    engine.receive({
      t: 'batch',
      data: {
        instance: server.instance,
        fromVersion: 5,
        toVersion: 7,
        epoch: 0,
        counts: server.counts(),
        changes: server.log.slice(5),
      },
    });
    expect(engine.instance).not.toBe(oldInstance);
    await api.flush();
    expect(ids(engine.right.mirror.items)).toEqual([40, 41, 42, 43, 44, 45, 46]);
  });

  it('data of a retired instance is ignored after the switch', async () => {
    const { server, api, engine, hello, oldInstance } = await started();
    server.restart();
    server.select(40);
    hello();
    await api.flush();
    const version = engine.version;
    const before = engine.right.mirror.items;
    engine.receive({
      t: 'batch',
      data: {
        instance: oldInstance,
        fromVersion: 5,
        toVersion: 6,
        epoch: 0,
        counts: { all: 50, selected: 6 },
        changes: [{ v: 6, type: 'selected', id: 9, key: 'zz' }],
      },
    });
    engine.receive({
      t: 'hello',
      data: {
        instance: oldInstance,
        version: 6,
        epoch: 0,
        counts: { all: 50, selected: 6 },
        nextAddInMs: 0,
      },
      at: Date.now(),
    });
    engine.receive({
      t: 'resync',
      data: { instance: oldInstance, version: 6, epoch: 0, reason: 'rebalance' },
    });
    expect(engine.instance).toBe(server.instance);
    expect(engine.version).toBe(version);
    expect(engine.right.mirror.items).toBe(before);
    expect(engine.counts).toEqual({ all: 50, selected: 1 });
  });

  it('a page of a new instance (restart noticed by a read) triggers the switch', async () => {
    const { server, api, engine, oldInstance } = await started();
    server.restart();
    server.select(40);
    engine.setFilter('selected', '4');
    await api.flush();
    expect(engine.instance).not.toBe(oldInstance);
    engine.setFilter('selected', '');
    await api.flush();
    expect(ids(engine.right.mirror.items)).toEqual([40]);
  });

  it('applied operations confirmed only by the old instance are dropped with a notice', async () => {
    const { server, api, engine, notices, hello } = await started();
    engine.select(9);
    await api.flush();
    expect(engine.ops[0]!.state).toBe('applied');
    server.restart();
    hello();
    expect(engine.ops).toHaveLength(0);
    expect(notices.some((n) => n.kind === 'error' && n.message.includes('не сохранилось'))).toBe(
      true,
    );
  });

  it('a mutation answered by the new instance before its hello: switch, op kept until confirmed', async () => {
    const { server, api, engine, batch, oldInstance } = await started();
    server.restart();
    engine.select(7);
    await api.flush();
    expect(engine.instance).not.toBe(oldInstance);
    expect(engine.ops).toHaveLength(0);
    batch();
    await api.flush();
    expect(ids(engine.right.mirror.items)).toEqual([7]);
  });

  it('a mutation answered by a retired instance is reported as lost, not as applied', async () => {
    const { server, api, engine, notices, hello } = await started();
    api.auto = false;
    engine.select(9);
    await Promise.resolve();
    const call = api.calls.find((c) => c.kind === 'select')!;
    api.serve(call);
    server.restart();
    hello();
    api.deliver(call);
    api.auto = true;
    await api.flush();
    expect(engine.ops).toHaveLength(0);
    expect(notices.some((n) => n.message.includes('операция не сохранилась'))).toBe(true);
  });

  it('catch-up with HISTORY_EXPIRED instance_changed switches to the reported instance', async () => {
    const { server, api, engine, oldInstance } = await started();
    server.restart();
    for (const id of [40, 41, 42, 43, 44, 45, 46]) server.select(id);
    await engine.catchUp();
    expect(api.log.find((c) => c.kind === 'changes')).toMatchObject({ args: [5, oldInstance] });
    expect(engine.instance).toBe(server.instance);
    await api.flush();
    expect(ids(engine.right.mirror.items)).toEqual([40, 41, 42, 43, 44, 45, 46]);
  });
});

describe('overlay', () => {
  const end = { kind: 'all' } as const;
  const op = (o: OpInput): PendingOp => ({
    opId: 1,
    idempotencyKey: 'k',
    group: null,
    state: 'sending' as const,
    version: null,
    instance: null,
    createdAt: 0,
    appliedAt: null,
    ...o,
  });

  it('move places the row after A, or before B when A is not visible', () => {
    const items = [1, 2, 3, 4].map((id) => ({ id, key: `a${id}` }));
    expect(
      ids(rightView(items, end, '', [op({ kind: 'move', id: 4, afterId: 1, beforeId: 2 })])),
    ).toEqual([1, 4, 2, 3]);
    expect(
      ids(rightView(items, end, '', [op({ kind: 'move', id: 1, afterId: null, beforeId: 4 })])),
    ).toEqual([2, 3, 1, 4]);
    expect(
      ids(rightView(items, end, '', [op({ kind: 'move', id: 3, position: 'first' })])),
    ).toEqual([3, 1, 2, 4]);
  });

  it('select appends only when the window reaches the end; deselect returns to the left in ID order', () => {
    const right = [{ id: 1, key: 'a1' }];
    expect(
      ids(rightView(right, { kind: 'pos', pos: 'a1' }, '', [op({ kind: 'select', id: 9 })])),
    ).toEqual([1]);
    expect(ids(rightView(right, end, '', [op({ kind: 'select', id: 9 })]))).toEqual([1, 9]);
    const left = [2, 5, 8].map((id) => ({ id, custom: false }));
    expect(
      ids(leftView(left, { kind: 'pos', pos: 8 }, '', [op({ kind: 'deselect', id: 6 })])),
    ).toEqual([2, 5, 6, 8]);
    expect(
      ids(leftView(left, { kind: 'pos', pos: 8 }, '', [op({ kind: 'deselect', id: 9 })])),
    ).toEqual([2, 5, 8]);
  });

  it('returns the same array when no operation affects the view', () => {
    const items = [{ id: 1, key: 'a1' }];
    expect(rightView(items, end, '', [])).toBe(items);
  });
});
