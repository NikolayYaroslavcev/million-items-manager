import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Prepared, ReorderInput, Store } from '../src/store/store.js';
import { makeStore } from './helpers/factories.js';
import { ReferenceModel } from './helpers/referenceModel.js';

function apply(store: Store, prepared: Prepared) {
  if (!prepared.ok) return { code: prepared.error.code as string, body: null };
  store.commit(prepared.plan, []);
  return { code: null, body: prepared.plan.response };
}

function walkLeft(store: Store, filter: string, limit = 20, budget = 100_000): number[] {
  const out: number[] = [];
  let pos = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    const r = store.readLeft(filter, pos, limit, budget);
    expect(r.items.length).toBeLessThanOrEqual(limit);
    out.push(...r.items.map((i) => i.id));
    if (r.done) {
      expect(r.nextPos).toBeNull();
      return out;
    }
    expect(r.nextPos!).toBeGreaterThan(pos);
    pos = r.nextPos!;
  }
  throw new Error('left scan did not terminate');
}

function walkRight(store: Store, filter: string, limit = 20, budget = 100_000): number[] {
  const out: number[] = [];
  let pos: string | null = null;
  for (let guard = 0; guard < 100_000; guard++) {
    const r = store.readRight(filter, pos, limit, budget);
    out.push(...r.items.map((i) => i.id));
    if (r.done) return out;
    expect(pos === null || r.nextPos! > pos).toBe(true);
    pos = r.nextPos;
  }
  throw new Error('right scan did not terminate');
}

describe('Store basics', () => {
  it('computes base existence and counts', () => {
    const s = makeStore({ baseMax: 100 });
    expect(s.exists(1)).toBe(true);
    expect(s.exists(100)).toBe(true);
    expect(s.exists(101)).toBe(false);
    expect(s.exists(0)).toBe(false);
    expect(s.counts()).toEqual({ all: 100, selected: 0 });
  });

  it('add / select / deselect with versions and change log', () => {
    const s = makeStore({ baseMax: 100 });
    expect(apply(s, s.prepareAdd(500)).body).toMatchObject({ item: { id: 500 }, version: 1 });
    expect(apply(s, s.prepareAdd(500)).code).toBe('ALREADY_EXISTS');
    expect(apply(s, s.prepareAdd(50)).code).toBe('ALREADY_EXISTS');
    expect(apply(s, s.prepareSelect(500)).body).toMatchObject({ changed: true, version: 2 });
    expect(apply(s, s.prepareSelect(500)).body).toMatchObject({ changed: false, version: 2 });
    expect(apply(s, s.prepareSelect(999)).code).toBe('NOT_FOUND');
    expect(apply(s, s.prepareDeselect(7)).body).toMatchObject({ changed: false, version: 2 });
    expect(apply(s, s.prepareDeselect(999)).code).toBe('NOT_FOUND');
    expect(apply(s, s.prepareDeselect(500)).body).toMatchObject({ changed: true, version: 3 });
    const log = s.changesSince(0, 100);
    expect(log.ok && log.changes.map((c) => [c.v, c.type, c.id])).toEqual([
      [1, 'added', 500],
      [2, 'selected', 500],
      [3, 'deselected', 500],
    ]);
    s.assertInvariants();
  });

  it('enforces the custom ID limit', () => {
    const s = makeStore({ baseMax: 10, maxCustomIds: 2 });
    apply(s, s.prepareAdd(11));
    apply(s, s.prepareAdd(12));
    expect(apply(s, s.prepareAdd(13)).code).toBe('CUSTOM_LIMIT_REACHED');
  });

  it('change log reports expired and ahead history', () => {
    const s = makeStore({ baseMax: 100, changeLogSize: 5 });
    for (let id = 1; id <= 8; id++) apply(s, s.prepareSelect(id));
    expect(s.changesSince(9, 10)).toEqual({ ok: false, reason: 'ahead' });
    expect(s.changesSince(2, 10)).toEqual({ ok: false, reason: 'expired' });
    const r = s.changesSince(3, 2);
    expect(r.ok && r.changes.map((c) => c.v)).toEqual([4, 5]);
    expect(r.ok && r.hasMore).toBe(true);
  });
});

describe('bitmap and custom IDs (T28)', () => {
  it('random select/deselect keeps I3/I4; left list = base then custom ascending', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 1, max: 2100 + 20 })), {
          maxLength: 300,
        }),
        (ops) => {
          const s = makeStore({ baseMax: 2100 });
          const ref = new ReferenceModel(2100);
          for (let c = 2101; c <= 2120; c += 2) {
            apply(s, s.prepareAdd(c));
            ref.add(c);
          }
          for (const [sel, id] of ops) {
            const bitmapBefore = s.baseSelected.slice();
            const r = apply(s, sel ? s.prepareSelect(id) : s.prepareDeselect(id));
            const e = sel ? ref.select(id) : ref.deselect(id);
            expect(r.code).toBe(e.code);
            if (id > 2100) expect(s.baseSelected).toEqual(bitmapBefore);
          }
          s.assertInvariants();
          expect(walkLeft(s, '')).toEqual(ref.left(''));
          expect(walkRight(s, '')).toEqual(ref.right(''));
        },
      ),
      { numRuns: 60 },
    );
  });

  it('never writes custom IDs into the bitmap', () => {
    const s = makeStore({ baseMax: 100 });
    apply(s, s.prepareAdd(1000));
    const before = s.baseSelected.slice();
    apply(s, s.prepareSelect(1000));
    expect(s.baseSelected).toEqual(before);
    apply(s, s.prepareDeselect(1000));
    expect(s.baseSelected).toEqual(before);
  });
});

describe('pagination without concurrent changes (T7)', () => {
  it('concatenated pages equal the reference list for random states and filters', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 2600 }), { maxLength: 400 }),
        fc.array(fc.integer({ min: 2501, max: 1_000_000 }), { maxLength: 40 }),
        fc.oneof(fc.constant(''), fc.stringMatching(/^\d{1,3}$/)),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 50 }),
        (selects, customs, filter, limit, budget) => {
          const s = makeStore({ baseMax: 2500 });
          const ref = new ReferenceModel(2500);
          for (const c of customs) {
            apply(s, s.prepareAdd(c));
            ref.add(c);
          }
          for (const id of selects) {
            apply(s, s.prepareSelect(id));
            ref.select(id);
          }
          expect(walkLeft(s, filter, limit, budget)).toEqual(ref.left(filter));
          expect(walkRight(s, filter, limit, budget)).toEqual(ref.right(filter));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('first page has at most 20 items and done is exact', () => {
    const s = makeStore({ baseMax: 20 });
    const r = s.readLeft('', 0, 20, 100_000);
    expect(r.items).toHaveLength(20);
    expect(r.done).toBe(true);
    const f = s.readLeft('1', 0, 20, 100_000);
    expect(f.items.map((i) => i.id)).toEqual([1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(f.done).toBe(true);
  });

  it('budget exhaustion returns partial pages with a cursor and no gaps', () => {
    const s = makeStore({ baseMax: 3000 });
    for (let id = 1; id <= 3000; id++) if (id % 7 !== 0) apply(s, s.prepareSelect(id));
    const r = s.readRight('7', null, 20, 10);
    expect(r.scanned).toBe(10);
    expect(r.done).toBe(false);
    expect(walkRight(s, '7', 20, 10)).toEqual(
      [...Array(3000).keys()]
        .map((i) => i + 1)
        .filter((id) => id % 7 !== 0 && String(id).includes('7')),
    );
  });

  it('skips fully selected blocks without scanning them', () => {
    const s = makeStore({ baseMax: 5000 });
    s.loadSelectedFixture([...Array(4096).keys()].map((i) => i + 1));
    const r = s.readLeft('', 0, 5, 100_000);
    expect(r.items.map((i) => i.id)).toEqual([4097, 4098, 4099, 4100, 4101]);
    expect(r.scanned).toBe(5);
  });
});

describe('reorder semantics (T6, plan 4.4)', () => {
  const setup = () => {
    const s = makeStore({ baseMax: 100 });
    for (const id of [1, 11, 12, 2, 3, 13]) apply(s, s.prepareSelect(id));
    return s;
  };
  const order = (s: Store) => walkRight(s, '');
  const reorder = (s: Store, input: ReorderInput) => apply(s, s.prepareReorder(input));

  it('between visible A and B with hidden items between: A, X, H1, H2, B', () => {
    const s = setup();
    expect(reorder(s, { id: 3, afterId: 1, beforeId: 2 }).code).toBeNull();
    expect(order(s)).toEqual([1, 3, 11, 12, 2, 13]);
  });

  it('before the first visible B with hidden items above: ..., X, B', () => {
    const s = setup();
    reorder(s, { id: 3, afterId: null, beforeId: 2 });
    expect(order(s)).toEqual([1, 11, 12, 3, 2, 13]);
  });

  it('after the last loaded visible A: A, X, ...', () => {
    const s = setup();
    reorder(s, { id: 1, afterId: 3, beforeId: null });
    expect(order(s)).toEqual([11, 12, 2, 3, 1, 13]);
  });

  it('first / last by position', () => {
    const s = setup();
    reorder(s, { id: 3, position: 'first' });
    expect(order(s)[0]).toBe(3);
    reorder(s, { id: 3, position: 'last' });
    expect(order(s).at(-1)).toBe(3);
    expect(reorder(s, { id: 3, position: 'last' }).body).toMatchObject({ changed: false });
  });

  it('anchor errors: missing, swapped, self, both empty, mixed', () => {
    const s = setup();
    expect(reorder(s, { id: 3, afterId: 50, beforeId: 2 }).code).toBe('ANCHOR_NOT_FOUND');
    expect(reorder(s, { id: 3, afterId: 1, beforeId: 999 }).code).toBe('ANCHOR_NOT_FOUND');
    expect(reorder(s, { id: 3, afterId: 2, beforeId: 1 }).code).toBe('ORDER_CONFLICT');
    expect(reorder(s, { id: 3, afterId: 3 }).code).toBe('INVALID_ANCHOR');
    expect(reorder(s, { id: 3, afterId: null, beforeId: null }).code).toBe('INVALID_ANCHOR');
    expect(reorder(s, { id: 3, afterId: 1, beforeId: 1 }).code).toBe('INVALID_ANCHOR');
    expect(reorder(s, { id: 3, afterId: 1, position: 'first' }).code).toBe('INVALID_ANCHOR');
    expect(reorder(s, { id: 50, afterId: 1 }).code).toBe('NOT_SELECTED');
    expect(reorder(s, { id: 5000, afterId: 1 }).code).toBe('NOT_SELECTED');
  });

  it('dropped on its own place → changed: false, version unchanged', () => {
    const s = setup();
    const v = s.version;
    expect(reorder(s, { id: 3, afterId: 2, beforeId: 13 }).body).toMatchObject({ changed: false });
    expect(reorder(s, { id: 3, afterId: null, beforeId: 13 }).body).toMatchObject({
      changed: false,
    });
    expect(s.version).toBe(v);
  });

  it('visible order A < X < B holds in any filter where A, X, B are visible', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 60 }), { minLength: 3, maxLength: 30 }),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (ids, xi, ai, bi) => {
          const s = makeStore({ baseMax: 100 });
          for (const id of ids) apply(s, s.prepareSelect(id));
          const x = ids[xi % ids.length]!;
          const others = ids.filter((i) => i !== x);
          const a = others[ai % others.length]!;
          const b = others[bi % others.length]!;
          const ia = ids.indexOf(a);
          const ib = ids.indexOf(b);
          const r = reorder(s, { id: x, afterId: a, beforeId: a === b ? null : b });
          if (a !== b && ia > ib) {
            expect(r.code).toBe('ORDER_CONFLICT');
            return;
          }
          expect(r.code).toBeNull();
          const o = order(s);
          expect(o.indexOf(a)).toBeLessThan(o.indexOf(x));
          if (a !== b) expect(o.indexOf(x)).toBeLessThan(o.indexOf(b));
          expect(o.filter((i) => i !== x)).toEqual(ids.filter((i) => i !== x));
          s.assertInvariants();
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('key rebalance (T17)', () => {
  it('local re-key: short keys again, same epoch, order kept, journal replays to the same state', () => {
    const s = makeStore({ baseMax: 100, keyMaxLen: 8 });
    for (let id = 1; id <= 10; id++) apply(s, s.prepareSelect(id));
    const ref = new ReferenceModel(100);
    for (let id = 1; id <= 10; id++) ref.select(id);
    const replica = new Map<number, string>(s.keyById);
    let rekeys = 0;
    for (let i = 0; i < 300; i++) {
      const id = (i % 9) + 2;
      const p = s.prepareReorder({ id, afterId: 1 });
      if (!p.ok) throw p.error;
      expect(p.plan.rebalanced).toBe(false);
      if (p.plan.changes.length > 1) rekeys++;
      const before = s.version;
      apply(s, p);
      expect(s.version).toBe(before + p.plan.changes.length);
      expect(p.plan.changes.map((c) => c.v)).toEqual(p.plan.changes.map((_, k) => before + 1 + k));
      expect((p.plan.response as { version: number }).version).toBe(s.version);
      for (const c of p.plan.changes) if (c.type === 'moved') replica.set(c.id, c.key);
      ref.reorder({ id, afterId: 1 });
      expect(walkRight(s, '')).toEqual(ref.right(''));
      expect(new Map(s.keyById)).toEqual(replica);
      for (const [key] of s.orderTree.entries()) expect(key.length).toBeLessThanOrEqual(8);
    }
    expect(rekeys).toBeGreaterThan(0);
    expect(s.epoch).toBe(0);
    s.assertInvariants();
  });

  it('local re-key never needs the global rebalance for repeated inserts into one spot of 100k', () => {
    const s = makeStore({ baseMax: 100_000 });
    s.loadSelectedFixture(Array.from({ length: 100_000 }, (_, i) => i + 1));
    for (let i = 0; i < 5000; i++) {
      const p = s.prepareReorder({ id: 50_001 + (i % 2), afterId: 50_000 });
      if (!p.ok) throw p.error;
      expect(p.plan.rebalanced).toBe(false);
      expect(p.plan.changes.length).toBeLessThanOrEqual(2 * 1024 + 1);
      apply(s, p);
    }
    expect(s.epoch).toBe(0);
    s.assertInvariants();
  });

  it('select at the end with exhausted keys re-keys locally as well', () => {
    const s = makeStore({ baseMax: 100, keyMaxLen: 4 });
    const ref = new ReferenceModel(100);
    for (let id = 1; id <= 100; id++) {
      const p = s.prepareSelect(id);
      if (!p.ok) throw p.error;
      apply(s, p);
      ref.select(id);
    }
    expect(walkRight(s, '')).toEqual(ref.right(''));
    s.assertInvariants();
  });

  it('global rebalance fallback: bumps epoch, keeps the order', () => {
    const s = makeStore({ baseMax: 100, keyMaxLen: 8, rekeyMaxSide: 0 });
    for (let id = 1; id <= 10; id++) apply(s, s.prepareSelect(id));
    const ref = new ReferenceModel(100);
    for (let id = 1; id <= 10; id++) ref.select(id);
    let rebalances = 0;
    for (let i = 0; i < 200; i++) {
      const id = (i % 9) + 2;
      const p = s.prepareReorder({ id, afterId: 1 });
      if (p.ok && p.plan.rebalanced) rebalances++;
      apply(s, p);
      ref.reorder({ id, afterId: 1 });
      expect(walkRight(s, '')).toEqual(ref.right(''));
      for (const [key] of s.orderTree.entries()) expect(key.length).toBeLessThanOrEqual(8);
    }
    expect(rebalances).toBeGreaterThan(0);
    expect(s.epoch).toBe(rebalances);
    expect(s.epochStartVersion).toBeGreaterThan(0);
    s.assertInvariants();
  });
});

describe('store vs reference model: random operation sequences', () => {
  it.each([
    { keyMaxLen: 10, rekeyMaxSide: 1024 },
    { keyMaxLen: 5, rekeyMaxSide: 2 },
    { keyMaxLen: 5, rekeyMaxSide: 1024 },
  ])('every result and the final state match (%o)', (storeOptions) => {
    const idArb = fc.integer({ min: 1, max: 40 });
    const opArb = fc.oneof(
      fc.record({ t: fc.constant('add' as const), id: fc.integer({ min: 30, max: 45 }) }),
      fc.record({ t: fc.constant('select' as const), id: idArb }),
      fc.record({ t: fc.constant('deselect' as const), id: idArb }),
      fc.record({
        t: fc.constant('reorder' as const),
        id: idArb,
        afterId: fc.option(idArb, { nil: null }),
        beforeId: fc.option(idArb, { nil: null }),
      }),
      fc.record({
        t: fc.constant('position' as const),
        id: idArb,
        position: fc.constantFrom('first' as const, 'last' as const),
      }),
    );
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 200 }), (ops) => {
        const s = makeStore({ baseMax: 30, ...storeOptions });
        const ref = new ReferenceModel(30);
        for (const op of ops) {
          let got: { code: string | null; body: unknown };
          let exp;
          switch (op.t) {
            case 'add':
              got = apply(s, s.prepareAdd(op.id));
              exp = ref.add(op.id);
              break;
            case 'select':
              got = apply(s, s.prepareSelect(op.id));
              exp = ref.select(op.id);
              break;
            case 'deselect':
              got = apply(s, s.prepareDeselect(op.id));
              exp = ref.deselect(op.id);
              break;
            case 'reorder':
              got = apply(s, s.prepareReorder(op));
              exp = ref.reorder(op);
              break;
            case 'position':
              got = apply(s, s.prepareReorder(op));
              exp = ref.reorder(op);
              break;
          }
          expect(got.code).toBe(exp.code);
          if (exp.changed !== undefined) {
            expect((got.body as { changed: boolean }).changed).toBe(exp.changed);
          }
        }
        s.assertInvariants();
        expect(walkLeft(s, '')).toEqual(ref.left(''));
        expect(walkRight(s, '')).toEqual(ref.right(''));
      }),
      { numRuns: 300 },
    );
  });
});
