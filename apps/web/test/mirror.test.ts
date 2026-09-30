import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Change, ItemsPage, SelectedPage } from '@mim/shared';
import { cursorPosition } from '@mim/shared';
import { ListMirror, leftSpec, rightSpec, type Bound } from '../src/sync/mirror.js';
import { ModelServer, match } from './helpers/model.js';

describe('ListMirror basics', () => {
  it('inserts, moves and removes by events only inside the window', () => {
    const m = new ListMirror(rightSpec);
    m.mergePage(
      {
        items: [
          { id: 1, key: 'a1' },
          { id: 2, key: 'a3' },
        ],
        from: { kind: 'none' },
        to: { kind: 'pos', pos: 'a5' },
      },
      [],
    );
    m.applyChanges([
      { v: 1, type: 'selected', id: 3, key: 'a2' },
      { v: 2, type: 'selected', id: 4, key: 'a9' },
      { v: 3, type: 'moved', id: 1, key: 'a8' },
    ]);
    expect(m.items.map((i) => i.id)).toEqual([3, 2]);
    m.applyChanges([{ v: 4, type: 'moved', id: 4, key: 'a0' }]);
    expect(m.items.map((i) => i.id)).toEqual([4, 3, 2]);
    m.applyChanges([{ v: 5, type: 'deselected', id: 3 }]);
    expect(m.items.map((i) => i.id)).toEqual([4, 2]);
  });

  it('left list: selected removes, deselected/added insert in ID order within the window', () => {
    const m = new ListMirror(leftSpec, '1');
    m.mergePage(
      {
        items: [
          { id: 1, custom: false },
          { id: 10, custom: false },
        ],
        from: { kind: 'none' },
        to: { kind: 'pos', pos: 12 },
      },
      [],
    );
    m.applyChanges([
      { v: 1, type: 'selected', id: 10, key: 'a0' },
      { v: 2, type: 'deselected', id: 11 },
      { v: 3, type: 'deselected', id: 5 },
      { v: 4, type: 'added', id: 13 },
    ]);
    expect(m.items).toEqual([
      { id: 1, custom: false },
      { id: 11, custom: false },
    ]);
  });

  it('merging a page replays later changes on the page slice', () => {
    const m = new ListMirror(rightSpec);
    m.mergePage(
      { items: [{ id: 1, key: 'a1' }], from: { kind: 'none' }, to: { kind: 'pos', pos: 'a1' } },
      [],
    );
    m.mergePage(
      {
        items: [
          { id: 2, key: 'a2' },
          { id: 3, key: 'a3' },
        ],
        from: { kind: 'pos', pos: 'a1' },
        to: { kind: 'pos', pos: 'a5' },
      },
      [
        { v: 8, type: 'moved', id: 7, key: 'a4' },
        { v: 9, type: 'moved', id: 2, key: 'a0' },
      ],
    );
    expect(m.items.map((i) => i.id)).toEqual([1, 3, 7]);
    expect(m.end).toEqual({ kind: 'pos', pos: 'a5' });
  });
});

describe('T27: ListMirror window equals the reference after any interleaving', () => {
  type Step =
    | { t: 'mutate'; op: number; a: number; b: number; c: number }
    | { t: 'event' }
    | { t: 'request' }
    | { t: 'serve' }
    | { t: 'deliver' };

  const step: fc.Arbitrary<Step> = fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        t: fc.constant('mutate' as const),
        op: fc.nat(3),
        a: fc.nat(60),
        b: fc.nat(60),
        c: fc.nat(60),
      }),
    },
    { weight: 3, arbitrary: fc.constant({ t: 'event' as const }) },
    { weight: 2, arbitrary: fc.constant({ t: 'request' as const }) },
    { weight: 2, arbitrary: fc.constant({ t: 'serve' as const }) },
    { weight: 2, arbitrary: fc.constant({ t: 'deliver' as const }) },
  );

  function run(list: 'items' | 'selected', filter: string, budget: number, steps: Step[]) {
    const server = new ModelServer(40);
    for (let id = 1; id <= 25; id += 2) server.select(id);
    const mirror =
      list === 'items'
        ? new ListMirror(leftSpec, filter)
        : (new ListMirror(rightSpec, filter) as unknown as ListMirror<{ id: number }, unknown>);
    let version = server.version;
    const buffer: Change[] = [];
    let cursor: string | null = null;
    let request: { from: Bound<unknown>; cursor: string | null } | null = null;
    let served: ItemsPage | SelectedPage | null = null;

    const mutate = (s: Extract<Step, { t: 'mutate' }>): void => {
      const ids = server.selected.map((x) => x.id);
      const pick = (n: number) => ids[n % Math.max(1, ids.length)] ?? null;
      if (s.op === 0) server.select((s.a % 45) + 1);
      else if (s.op === 1 && ids.length) server.deselect(pick(s.a)!);
      else if (s.op === 2 && ids.length > 1) {
        const x = pick(s.a)!;
        const anchor = pick(s.b);
        if (anchor !== null && anchor !== x) {
          if (s.c % 2) server.move(x, anchor, null);
          else server.move(x, null, anchor);
        }
      } else if (s.op === 3) server.add(1000 + s.a);
    };
    const deliverEvent = (): boolean => {
      const next = server.log.find((c) => c.v === version + 1);
      if (!next) return false;
      mirror.applyChanges([next]);
      buffer.push(next);
      version = next.v;
      return true;
    };
    const deliverPage = (): boolean => {
      if (!served || !request || served.version > version) return false;
      const later = buffer.filter((c) => c.v > served!.version && c.v <= version);
      const page = served;
      const to: Bound<unknown> = page.done
        ? { kind: 'all' }
        : { kind: 'pos', pos: cursorPosition(page.nextCursor!, list as 'items') };
      mirror.mergePage({ items: page.items as { id: number }[], from: request.from, to }, later);
      cursor = page.nextCursor;
      request = null;
      served = null;
      return true;
    };
    const view = (xs: readonly { id: number }[]) => (list === 'items' ? xs.map((x) => x.id) : xs);
    const check = (): void => {
      const expected = (list === 'items' ? server.leftAll(filter) : server.rightAll(filter)).filter(
        (item) =>
          mirror.end.kind === 'all' ||
          (mirror.end.kind === 'pos' &&
            (list === 'items'
              ? item.id <= (mirror.end.pos as number)
              : (item as { key: string }).key <= (mirror.end.pos as string))),
      );
      expect(view(mirror.items)).toEqual(view(expected));
      const ids = mirror.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const item of mirror.items) expect(match(item.id, filter)).toBe(true);
    };

    for (const s of steps) {
      if (s.t === 'mutate') mutate(s);
      else if (s.t === 'event') deliverEvent();
      else if (s.t === 'request') {
        if (!request && !mirror.done) request = { from: mirror.end, cursor };
      } else if (s.t === 'serve') {
        if (request && !served) {
          served =
            list === 'items'
              ? server.itemsPage(filter, request.cursor, 5, budget)
              : server.selectedPage(filter, request.cursor, 5, budget);
        }
      } else if (s.t === 'deliver') deliverPage();
      if (!request && version === server.version) check();
    }
    while (deliverEvent());
    if (request && !served) {
      served =
        list === 'items'
          ? server.itemsPage(filter, request.cursor, 5, budget)
          : server.selectedPage(filter, request.cursor, 5, budget);
    }
    while (deliverEvent());
    deliverPage();
    check();
    for (let guard = 0; guard < 200 && !mirror.done; guard++) {
      request = { from: mirror.end, cursor };
      served =
        list === 'items'
          ? server.itemsPage(filter, cursor, 5, budget)
          : server.selectedPage(filter, cursor, 5, budget);
      deliverPage();
    }
    expect(view(mirror.items)).toEqual(
      view(list === 'items' ? server.leftAll(filter) : server.rightAll(filter)),
    );
  }

  for (const list of ['selected', 'items'] as const) {
    it(`${list}: 1 000 random interleavings`, () => {
      fc.assert(
        fc.property(
          fc.constantFrom('', '1', '2', '3'),
          fc.integer({ min: 2, max: 30 }),
          fc.array(step, { minLength: 10, maxLength: 120 }),
          (filter, budget, steps) => run(list, filter, budget, steps),
        ),
        { numRuns: 1000 },
      );
    });
  }
});
