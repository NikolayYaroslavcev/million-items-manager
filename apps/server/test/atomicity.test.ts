import { describe, expect, it, vi } from 'vitest';
import type { EngineFaults, MutationInput } from '../src/core/engine.js';
import { resultCode, type OpResult } from '../src/errors.js';
import type { Store, StoreOptions } from '../src/store/store.js';
import { makeEngine, makeStore } from './helpers/factories.js';

type Scenario = {
  name: string;
  setup(store: Store): void;
  submit(engine: ReturnType<typeof makeEngine>['engine']): Promise<OpResult>;
  prepare(store: Store): ReturnType<Store['prepareSelect']>;
  isAdd?: boolean;
  store?: Partial<StoreOptions>;
};

function seed(store: Store): void {
  for (const id of [1, 2, 3, 4, 5]) {
    const p = store.prepareSelect(id);
    if (p.ok) store.commit(p.plan, []);
  }
  const a = store.prepareAdd(5000);
  if (a.ok) store.commit(a.plan, []);
}

const mutation =
  (input: MutationInput): Scenario['submit'] =>
  (engine) =>
    engine.submitMutation(input);

const scenarios: Scenario[] = [
  {
    name: 'add',
    setup: seed,
    submit: (e) => e.submitAdd(6000),
    prepare: (s) => s.prepareAdd(6000),
    isAdd: true,
  },
  {
    name: 'select base',
    setup: seed,
    submit: mutation({ kind: 'select', id: 10 }),
    prepare: (s) => s.prepareSelect(10),
  },
  {
    name: 'select custom',
    setup: seed,
    submit: mutation({ kind: 'select', id: 5000 }),
    prepare: (s) => s.prepareSelect(5000),
  },
  {
    name: 'deselect',
    setup: seed,
    submit: mutation({ kind: 'deselect', id: 3 }),
    prepare: (s) => s.prepareDeselect(3),
  },
  {
    name: 'reorder',
    setup: seed,
    submit: mutation({ kind: 'reorder', input: { id: 5, afterId: 1, beforeId: 2 } }),
    prepare: (s) => s.prepareReorder({ id: 5, afterId: 1, beforeId: 2 }),
  },
  {
    name: 'reorder with local re-key',
    setup: (s) => {
      seed(s);
      for (let i = 0; i < 1000; i++) {
        const p = s.prepareReorder({ id: (i % 2) + 2, afterId: 1 });
        if (!p.ok) throw p.error;
        if (p.plan.changes.length > 1) return;
        s.commit(p.plan, []);
      }
      throw new Error('no re-key reached');
    },
    submit: (e) => {
      const first = [...e.store.orderTree.entries()][1]![1];
      return e.submitMutation({ kind: 'reorder', input: { id: first === 2 ? 3 : 2, afterId: 1 } });
    },
    prepare: (s) => {
      const first = [...s.orderTree.entries()][1]![1];
      return s.prepareReorder({ id: first === 2 ? 3 : 2, afterId: 1 });
    },
  },
  {
    name: 'reorder with global rebalance',
    store: { rekeyMaxSide: 0 },
    setup: (s) => {
      seed(s);
      for (let i = 0; i < 1000; i++) {
        const p = s.prepareReorder({ id: (i % 2) + 2, afterId: 1 });
        if (!p.ok) throw p.error;
        if (p.plan.rebalanced) return;
        s.commit(p.plan, []);
      }
      throw new Error('no rebalance reached');
    },
    submit: (e) => {
      const s = e.store;
      const first = [...s.orderTree.entries()][1]![1];
      return e.submitMutation({ kind: 'reorder', input: { id: first === 2 ? 3 : 2, afterId: 1 } });
    },
    prepare: (s) => {
      const first = [...s.orderTree.entries()][1]![1];
      return s.prepareReorder({ id: first === 2 ? 3 : 2, afterId: 1 });
    },
  },
];

function setupEngine(scenario: Scenario, faults: EngineFaults, onFatal = vi.fn()) {
  const store = makeStore({ baseMax: 3000, keyMaxLen: 10, ...scenario.store });
  scenario.setup(store);
  const ctx = makeEngine({ store, hooks: { faults, onFatal } });
  const published: unknown[] = [];
  ctx.engine.onBatch((b) => published.push(b));
  return { ...ctx, published, onFatal };
}

async function runTick(ctx: ReturnType<typeof setupEngine>, scenario: Scenario) {
  const target = scenario.isAdd ? 10_000 : 1000;
  await ctx.clock.advanceTo(Math.ceil((ctx.clock.now() + 1) / target) * target);
}

describe('T24: failure in prepare', () => {
  it('500 INTERNAL, state and version unchanged, a retry succeeds', async () => {
    let fail = true;
    const ctx = setupEngine(scenarios[1]!, {
      beforePrepare: () => {
        if (fail) throw new Error('boom');
      },
    });
    const before = ctx.store.digest();
    const p = ctx.engine.submitMutation({ kind: 'select', id: 10 });
    await ctx.clock.advanceTo(1000);
    const r = await p;
    expect(r.status).toBe(500);
    expect(resultCode(r)).toBe('INTERNAL');
    expect(ctx.store.digest()).toBe(before);
    fail = false;
    const retry = ctx.engine.submitMutation({ kind: 'select', id: 10 });
    await ctx.clock.advanceTo(2000);
    expect((await retry).status).toBe(200);
  });
});

describe('T25a: failure after every k-th write, for every mutation type', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const probe = makeStore({ baseMax: 3000, keyMaxLen: 10, ...scenario.store });
      scenario.setup(probe);
      const plan = scenario.prepare(probe);
      if (!plan.ok) throw plan.error;
      expect(plan.plan.writes.length).toBeGreaterThan(1);
      if (scenario.name.includes('rebalance')) expect(plan.plan.rebalanced).toBe(true);
      if (scenario.name.includes('re-key')) expect(plan.plan.changes.length).toBeGreaterThan(1);

      const clean = setupEngine(scenario, {});
      const cleanP = scenario.submit(clean.engine);
      await runTick(clean, scenario);
      const expected = await cleanP;
      const expectedDigest = clean.store.digest();

      for (let k = 0; k < plan.plan.writes.length; k++) {
        let armed = true;
        const ctx = setupEngine(scenario, {
          beforeWrite: (i) => {
            if (armed && i === k) {
              armed = false;
              throw new Error(`fault at write ${k}`);
            }
          },
        });
        const before = ctx.store.digest();
        const version = ctx.store.version;
        const p = scenario.submit(ctx.engine);
        await runTick(ctx, scenario);
        const r = await p;
        expect(resultCode(r), `k=${k}`).toBe('INTERNAL');
        expect(ctx.store.digest(), `k=${k}`).toBe(before);
        expect(ctx.store.version).toBe(version);
        expect(ctx.published).toEqual([]);
        expect(ctx.engine.isFatal).toBe(false);
        expect(ctx.onFatal).not.toHaveBeenCalled();
        const retry = scenario.submit(ctx.engine);
        await runTick(ctx, scenario);
        expect(await retry).toEqual(expected);
        expect(ctx.store.digest()).toBe(expectedDigest);
      }
    });
  }
});

describe('T25b/T25c: outcome cannot be proven → OUTCOME_UNKNOWN and emergency mode', () => {
  it('T25b: rollback itself fails', async () => {
    const ctx = setupEngine(scenarios[1]!, {
      beforeWrite: (i) => {
        if (i === 2) throw new Error('commit fault');
      },
      beforeUndo: () => {
        throw new Error('undo fault');
      },
    });
    const p = ctx.engine.submitMutation({ kind: 'select', id: 10 });
    await ctx.clock.advanceTo(1000);
    expect(resultCode(await p)).toBe('OUTCOME_UNKNOWN');
    expect(ctx.engine.isFatal).toBe(true);
    expect(ctx.onFatal).toHaveBeenCalledTimes(1);
    expect(resultCode(await ctx.engine.submitMutation({ kind: 'select', id: 12 }))).toBe(
      'SHUTTING_DOWN',
    );
  });

  it('T25b: operations queued behind the failed one get 503 SHUTTING_DOWN, not applied', async () => {
    const ctx = setupEngine(scenarios[1]!, {
      beforeWrite: (i, plan) => {
        if (plan.kind === 'select' && i === 1) throw new Error('commit fault');
      },
      beforeUndo: () => {
        throw new Error('undo fault');
      },
    });
    const failing = ctx.engine.submitMutation({ kind: 'select', id: 10 });
    const behind = ctx.engine.submitMutation({ kind: 'deselect', id: 1 });
    await ctx.clock.advanceTo(1000);
    expect(resultCode(await failing)).toBe('OUTCOME_UNKNOWN');
    await ctx.engine.shutdown();
    expect(resultCode(await behind)).toBe('SHUTTING_DOWN');
    expect(ctx.store.isSelected(1)).toBe(true);
  });

  it('T25c: a consistent change outside the plan cells is caught (invariants alone would pass)', async () => {
    const ctx = setupEngine(scenarios[1]!, {
      beforeWrite: (i) => {
        if (i === 2) throw new Error('commit fault');
      },
      afterRollback: (store) => {
        store.baseSelected[2000] = 1;
        store.blockFree[(2000 - 1) >> 10]!--;
        store.orderTree.set('zz', 2000);
        store.keyById.set(2000, 'zz');
        store.assertInvariants();
      },
    });
    const p = ctx.engine.submitMutation({ kind: 'select', id: 10 });
    await ctx.clock.advanceTo(1000);
    expect(resultCode(await p)).toBe('OUTCOME_UNKNOWN');
    expect(ctx.engine.isFatal).toBe(true);
  });

  it('emergency stop mid-batch: the published batch covers exactly the committed changes', async () => {
    const ctx = setupEngine(scenarios[1]!, {
      beforeWrite: (i, plan) => {
        if (plan.kind === 'deselect' && i === plan.writes.length - 1) {
          throw new Error('commit fault');
        }
      },
      beforeUndo: (_i, plan) => {
        if (plan.kind === 'deselect') throw new Error('undo fault');
      },
    });
    const version = ctx.store.version;
    const ok = ctx.engine.submitMutation({ kind: 'select', id: 10 });
    const failing = ctx.engine.submitMutation({ kind: 'deselect', id: 3 });
    await ctx.clock.advanceTo(1000);
    expect((await ok).status).toBe(200);
    expect(resultCode(await failing)).toBe('OUTCOME_UNKNOWN');
    expect(ctx.store.version).toBe(version + 2);
    expect(ctx.published).toHaveLength(1);
    const batch = ctx.published[0] as {
      fromVersion: number;
      toVersion: number;
      changes: unknown[];
    };
    expect(batch).toMatchObject({ fromVersion: version, toVersion: version + 1 });
    expect(batch.changes).toHaveLength(1);
  });

  it('T25c: rollback succeeds but the snapshot check fails although invariants hold', async () => {
    const ctx = setupEngine(scenarios[4]!, {
      beforeWrite: (i) => {
        if (i === 3) throw new Error('commit fault');
      },
      afterRollback: (store, plan) => {
        for (const w of plan.writes) {
          if (w.cell.label.startsWith('orderTree(') || w.cell.label.startsWith('keyById(')) {
            w.cell.set(w.next);
          }
        }
        store.assertInvariants();
      },
    });
    const p = ctx.engine.submitMutation({
      kind: 'reorder',
      input: { id: 5, afterId: 1, beforeId: 2 },
    });
    await ctx.clock.advanceTo(1000);
    expect(resultCode(await p)).toBe('OUTCOME_UNKNOWN');
    expect(ctx.engine.isFatal).toBe(true);
    expect(ctx.onFatal).toHaveBeenCalledTimes(1);
  });
});
