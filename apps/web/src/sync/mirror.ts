import { BASE_MAX, type Change, type LeftItem, type SelectedItem } from '@mim/shared';

export type ListKind = 'items' | 'selected';

export type Bound<P> = { kind: 'none' } | { kind: 'pos'; pos: P } | { kind: 'all' };

type Effect<T> = { type: 'remove'; id: number } | { type: 'upsert'; item: T } | null;

export interface ListSpec<T extends { id: number }, P> {
  kind: ListKind;
  pos(item: T): P;
  cmp(a: P, b: P): number;
  effect(change: Change): Effect<T>;
}

export const leftSpec: ListSpec<LeftItem, number> = {
  kind: 'items',
  pos: (item) => item.id,
  cmp: (a, b) => a - b,
  effect(change) {
    switch (change.type) {
      case 'selected':
        return { type: 'remove', id: change.id };
      case 'deselected':
      case 'added':
        return { type: 'upsert', item: { id: change.id, custom: change.id > BASE_MAX } };
      case 'moved':
        return null;
    }
  },
};

export const rightSpec: ListSpec<SelectedItem, string> = {
  kind: 'selected',
  pos: (item) => item.key,
  cmp: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  effect(change) {
    switch (change.type) {
      case 'selected':
      case 'moved':
        return { type: 'upsert', item: { id: change.id, key: change.key } };
      case 'deselected':
        return { type: 'remove', id: change.id };
      case 'added':
        return null;
    }
  },
};

export function matchesFilter(id: number, filter: string): boolean {
  return filter === '' || String(id).includes(filter);
}

export function withinBound<P>(cmp: (a: P, b: P) => number, pos: P, bound: Bound<P>): boolean {
  if (bound.kind === 'all') return true;
  if (bound.kind === 'none') return false;
  return cmp(pos, bound.pos) <= 0;
}

function inInterval<P>(cmp: (a: P, b: P) => number, pos: P, lo: Bound<P>, hi: Bound<P>): boolean {
  return !withinBound(cmp, pos, lo) && withinBound(cmp, pos, hi);
}

export function sameBound<P>(a: Bound<P>, b: Bound<P>): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'pos' || a.pos === (b as { pos: P }).pos;
}

export interface PageSlice<T, P> {
  items: readonly T[];
  from: Bound<P>;
  to: Bound<P>;
}

export class ListMirror<T extends { id: number }, P> {
  items: readonly T[] = [];
  end: Bound<P> = { kind: 'none' };
  private readonly positions = new Map<number, P>();

  constructor(
    readonly spec: ListSpec<T, P>,
    public filter = '',
  ) {}

  get done(): boolean {
    return this.end.kind === 'all';
  }

  has(id: number): boolean {
    return this.positions.has(id);
  }

  reset(filter: string = this.filter): void {
    this.filter = filter;
    this.items = [];
    this.end = { kind: 'none' };
    this.positions.clear();
  }

  applyChanges(changes: readonly Change[]): boolean {
    let next: T[] | null = null;
    for (const change of changes) {
      const effect = this.spec.effect(change);
      if (!effect) continue;
      const id = effect.type === 'remove' ? effect.id : effect.item.id;
      const inWindow =
        effect.type === 'upsert' &&
        matchesFilter(id, this.filter) &&
        withinBound(this.spec.cmp, this.spec.pos(effect.item), this.end);
      if (!inWindow && !this.positions.has(id)) continue;
      next ??= this.items.slice();
      this.removeFrom(next, id);
      if (inWindow) this.insertInto(next, (effect as { item: T }).item);
    }
    if (!next) return false;
    this.items = next;
    return true;
  }

  mergePage(slice: PageSlice<T, P>, later: readonly Change[]): void {
    const { cmp } = this.spec;
    const page = new Map<number, T>();
    for (const item of slice.items) {
      if (inInterval(cmp, this.spec.pos(item), slice.from, slice.to)) page.set(item.id, item);
    }
    for (const change of later) {
      const effect = this.spec.effect(change);
      if (!effect) continue;
      const id = effect.type === 'remove' ? effect.id : effect.item.id;
      page.delete(id);
      if (
        effect.type === 'upsert' &&
        matchesFilter(id, this.filter) &&
        inInterval(cmp, this.spec.pos(effect.item), slice.from, slice.to)
      ) {
        page.set(id, effect.item);
      }
    }
    const added = [...page.values()]
      .filter((item) => !this.positions.has(item.id))
      .sort((a, b) => cmp(this.spec.pos(a), this.spec.pos(b)));
    for (const item of added) this.positions.set(item.id, this.spec.pos(item));
    if (added.length > 0) this.items = this.items.concat(added);
    this.end = slice.to;
  }

  private removeFrom(arr: T[], id: number): void {
    const pos = this.positions.get(id);
    if (pos === undefined) return;
    this.positions.delete(id);
    let i = this.lowerBound(arr, pos);
    while (i < arr.length && arr[i]!.id !== id) i++;
    if (i < arr.length) arr.splice(i, 1);
    else {
      const j = arr.findIndex((item) => item.id === id);
      if (j >= 0) arr.splice(j, 1);
    }
  }

  private insertInto(arr: T[], item: T): void {
    const pos = this.spec.pos(item);
    arr.splice(this.lowerBound(arr, pos), 0, item);
    this.positions.set(item.id, pos);
  }

  private lowerBound(arr: readonly T[], pos: P): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.spec.cmp(this.spec.pos(arr[mid]!), pos) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

export type LeftMirror = ListMirror<LeftItem, number>;
export type RightMirror = ListMirror<SelectedItem, string>;
