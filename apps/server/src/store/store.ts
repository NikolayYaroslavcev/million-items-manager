import { createHash, randomUUID } from 'node:crypto';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import type { Change, Counts, LeftItem, SelectedItem } from '@mim/shared';
import { AppError } from '../errors.js';
import { numberTree, stringTree, type BTree } from './btree.js';
import { nextMatch } from './nextMatch.js';

export const ABSENT: unique symbol = Symbol('absent');

export interface Cell {
  readonly label: string;
  get(): unknown;
  set(value: unknown): void;
}

export interface CellWrite {
  cell: Cell;
  prev: unknown;
  next: unknown;
}

export type MutationKind = 'add' | 'select' | 'deselect' | 'reorder';

type ChangeBody = Change extends infer C ? (C extends Change ? Omit<C, 'v'> : never) : never;

export interface MutationPlan {
  kind: MutationKind;
  writes: CellWrite[];
  changes: Change[];
  rebalanced: boolean;
  response: Record<string, unknown>;
}

export type Prepared = { ok: true; plan: MutationPlan } | { ok: false; error: AppError };

export interface ReorderInput {
  id: number;
  afterId?: number | null;
  beforeId?: number | null;
  position?: 'first' | 'last';
}

export interface CommitFaults {
  beforeWrite?(index: number, plan: MutationPlan): void;
  beforeUndo?(index: number, plan: MutationPlan): void;
  afterRollback?(store: Store, plan: MutationPlan): void;
}

export interface ScanResult<T, P> {
  items: T[];
  nextPos: P | null;
  done: boolean;
  scanned: number;
}

export interface StoreOptions {
  baseMax: number;
  maxCustomIds: number;
  keyMaxLen: number;
  changeLogSize: number;
  instance?: string;
  rekeyMaxSide?: number;
}

const REKEY_MIN_SIDE = 8;
export const REKEY_MAX_SIDE_DEFAULT = 1024;

const BLOCK_SHIFT = 10;
const BLOCK_SIZE = 1 << BLOCK_SHIFT;

export type ChangesSince =
  | { ok: true; changes: Change[]; hasMore: boolean; toVersion: number }
  | { ok: false; reason: 'expired' | 'ahead' };

export class Store {
  readonly baseMax: number;
  readonly maxCustomIds: number;
  readonly keyMaxLen: number;
  readonly changeLogSize: number;
  readonly instance: string;
  readonly rekeyMaxSide: number;

  baseSelected: Uint8Array;
  blockFree: Uint16Array;
  customSet = new Set<number>();
  leftCustom: BTree<number, true> = numberTree<true>();
  orderTree: BTree<string, number> = stringTree<number>();
  keyById = new Map<number, string>();
  epoch = 0;
  epochStartVersion = 0;
  version = 0;
  changeLog: (Change | undefined)[];

  constructor(options: StoreOptions) {
    this.baseMax = options.baseMax;
    this.maxCustomIds = options.maxCustomIds;
    this.keyMaxLen = options.keyMaxLen;
    this.changeLogSize = options.changeLogSize;
    this.instance = options.instance ?? randomUUID();
    this.rekeyMaxSide = options.rekeyMaxSide ?? REKEY_MAX_SIDE_DEFAULT;
    this.baseSelected = new Uint8Array(this.baseMax + 1);
    const blocks = Math.ceil(this.baseMax / BLOCK_SIZE);
    this.blockFree = new Uint16Array(blocks);
    for (let b = 0; b < blocks; b++) this.blockFree[b] = this.blockLength(b);
    this.changeLog = new Array<Change | undefined>(this.changeLogSize);
  }

  isBase(id: number): boolean {
    return id >= 1 && id <= this.baseMax;
  }

  exists(id: number): boolean {
    return this.isBase(id) || this.customSet.has(id);
  }

  isSelected(id: number): boolean {
    return this.keyById.has(id);
  }

  keyOf(id: number): string | undefined {
    return this.keyById.get(id);
  }

  counts(): Counts {
    return { all: this.baseMax + this.customSet.size, selected: this.keyById.size };
  }

  get customCount(): number {
    return this.customSet.size;
  }

  oldestLoggedVersion(): number {
    return Math.max(1, this.version - this.changeLogSize + 1);
  }

  changesSince(since: number, max: number): ChangesSince {
    if (since > this.version) return { ok: false, reason: 'ahead' };
    if (since < this.oldestLoggedVersion() - 1) return { ok: false, reason: 'expired' };
    const to = Math.min(this.version, since + max);
    const changes: Change[] = [];
    for (let v = since + 1; v <= to; v++) changes.push(this.changeLog[v % this.changeLogSize]!);
    return { ok: true, changes, hasMore: to < this.version, toVersion: to };
  }

  readLeft(
    filter: string,
    afterPos: number,
    limit: number,
    budget: number,
  ): ScanResult<LeftItem, number> {
    const items: LeftItem[] = [];
    let scanned = 0;
    let pos = afterPos;
    const stop = (): ScanResult<LeftItem, number> => ({
      items,
      nextPos: pos,
      done: false,
      scanned,
    });

    if (pos < this.baseMax) {
      let x = Math.max(1, pos + 1);
      while (x <= this.baseMax) {
        if (filter !== '') {
          const m = nextMatch(x, filter, this.baseMax);
          if (m === null) {
            x = this.baseMax + 1;
            break;
          }
          x = m;
        }
        const block = (x - 1) >> BLOCK_SHIFT;
        if (this.blockFree[block] === 0) {
          x = Math.min(this.baseMax, (block + 1) * BLOCK_SIZE) + 1;
          pos = x - 1;
          continue;
        }
        if (scanned >= budget) return stop();
        if (this.baseSelected[x] === 0) {
          if (items.length >= limit) return stop();
          items.push({ id: x, custom: false });
        }
        scanned++;
        pos = x;
        x++;
      }
      pos = this.baseMax;
    }

    for (let id = this.leftCustom.nextHigherKey(pos); id !== undefined;) {
      if (scanned >= budget) return stop();
      if (filter === '' || String(id).includes(filter)) {
        if (items.length >= limit) return stop();
        items.push({ id, custom: true });
      }
      scanned++;
      pos = id;
      id = this.leftCustom.nextHigherKey(id);
    }
    return { items, nextPos: null, done: true, scanned };
  }

  readRight(
    filter: string,
    afterKey: string | null,
    limit: number,
    budget: number,
  ): ScanResult<SelectedItem, string> {
    const items: SelectedItem[] = [];
    let scanned = 0;
    let pos = afterKey;
    for (const [key, id] of this.orderTree.entries(afterKey ?? undefined)) {
      if (key === afterKey) continue;
      if (scanned >= budget) return { items, nextPos: pos, done: false, scanned };
      if (filter === '' || String(id).includes(filter)) {
        if (items.length >= limit) return { items, nextPos: pos, done: false, scanned };
        items.push({ id, key });
      }
      scanned++;
      pos = key;
    }
    return { items, nextPos: null, done: true, scanned };
  }

  prepareAdd(id: number): Prepared {
    if (this.exists(id)) {
      return this.reject('ALREADY_EXISTS', `ID ${id} already exists`, { id, reason: 'exists' });
    }
    if (this.customSet.size >= this.maxCustomIds) {
      return this.reject('CUSTOM_LIMIT_REACHED', 'Custom ID limit reached', {
        limit: this.maxCustomIds,
      });
    }
    const writes = [
      this.write(this.customSetCell(id), true),
      this.write(this.leftCustomCell(id), true),
    ];
    return this.finalize('add', writes, [{ type: 'added', id }], false, (version, counts) => ({
      item: { id, custom: true },
      version,
      counts,
    }));
  }

  prepareSelect(id: number): Prepared {
    if (!this.exists(id)) return this.reject('NOT_FOUND', `ID ${id} does not exist`, { id });
    const current = this.keyById.get(id);
    if (current !== undefined) {
      return this.noop('select', { id, key: current, epoch: this.epoch, changed: false });
    }
    const writes = this.leftListRemoval(id);
    const last = this.orderTree.maxKey() ?? null;
    const key = generateKeyBetween(last, null);
    if (key.length > this.keyMaxLen) {
      return this.placeWithRekey('select', writes, id, null, last, null, () => {
        const ids = this.orderedIds();
        ids.push(id);
        return ids;
      });
    }
    writes.push(this.write(this.orderTreeCell(key), id), this.write(this.keyByIdCell(id), key));
    return this.finalize('select', writes, [{ type: 'selected', id, key }], false, (v, counts) => ({
      id,
      key,
      epoch: this.epoch,
      changed: true,
      version: v,
      counts,
    }));
  }

  prepareDeselect(id: number): Prepared {
    if (!this.exists(id)) return this.reject('NOT_FOUND', `ID ${id} does not exist`, { id });
    const key = this.keyById.get(id);
    if (key === undefined) return this.noop('deselect', { id, changed: false });
    const writes = [
      this.write(this.orderTreeCell(key), ABSENT),
      this.write(this.keyByIdCell(id), ABSENT),
    ];
    if (this.isBase(id)) {
      const block = (id - 1) >> BLOCK_SHIFT;
      writes.push(
        this.write(this.baseSelectedCell(id), 0),
        this.write(this.blockFreeCell(block), this.blockFree[block]! + 1),
      );
    } else {
      writes.push(this.write(this.leftCustomCell(id), true));
    }
    return this.finalize('deselect', writes, [{ type: 'deselected', id }], false, (v, counts) => ({
      id,
      changed: true,
      version: v,
      counts,
    }));
  }

  prepareReorder(input: ReorderInput): Prepared {
    const invalid = validateReorderShape(input);
    if (invalid) return { ok: false, error: invalid };
    const { id } = input;
    const keyX = this.keyById.get(id);
    if (keyX === undefined) return this.reject('NOT_SELECTED', `ID ${id} is not selected`, { id });
    const unchanged = (): Prepared =>
      this.noop('reorder', { id, key: keyX, epoch: this.epoch, changed: false });

    let lo: string | null;
    let hi: string | null;
    let place: { after: number } | { before: number } | 'first' | 'last';

    if (input.position === 'first') {
      const first = this.orderTree.minKey()!;
      if (first === keyX) return unchanged();
      [lo, hi, place] = [null, first, 'first'];
    } else if (input.position === 'last') {
      const last = this.orderTree.maxKey()!;
      if (last === keyX) return unchanged();
      [lo, hi, place] = [last, null, 'last'];
    } else {
      const afterId = input.afterId ?? null;
      const beforeId = input.beforeId ?? null;
      const keyA = afterId === null ? null : this.keyById.get(afterId);
      const keyB = beforeId === null ? null : this.keyById.get(beforeId);
      if (keyA === undefined || keyB === undefined) {
        const missing = keyA === undefined ? afterId : beforeId;
        return this.reject('ANCHOR_NOT_FOUND', `Anchor ${missing} is not selected`, {
          anchorId: missing,
        });
      }
      if (keyA !== null && keyB !== null && keyA >= keyB) {
        return this.reject('ORDER_CONFLICT', 'afterId is no longer placed before beforeId', {
          afterId,
          beforeId,
        });
      }
      if (keyA !== null) {
        const succ = this.orderTree.nextHigherKey(keyA) ?? null;
        if (succ === keyX) return unchanged();
        [lo, hi, place] = [keyA, succ, { after: afterId! }];
      } else {
        const pred = this.orderTree.nextLowerKey(keyB!) ?? null;
        if (pred === keyX) return unchanged();
        [lo, hi, place] = [pred, keyB!, { before: beforeId! }];
      }
    }

    const newKey = generateKeyBetween(lo, hi);
    if (newKey.length > this.keyMaxLen) {
      return this.placeWithRekey('reorder', [], id, keyX, lo, hi, () => {
        const ids = this.orderedIds().filter((x) => x !== id);
        if (place === 'first') ids.unshift(id);
        else if (place === 'last') ids.push(id);
        else if ('after' in place) ids.splice(ids.indexOf(place.after) + 1, 0, id);
        else ids.splice(ids.indexOf(place.before), 0, id);
        return ids;
      });
    }
    const writes = [
      this.write(this.orderTreeCell(keyX), ABSENT),
      this.write(this.orderTreeCell(newKey), id),
      this.write(this.keyByIdCell(id), newKey),
    ];
    return this.finalize(
      'reorder',
      writes,
      [{ type: 'moved', id, key: newKey }],
      false,
      (v, c) => ({
        id,
        key: newKey,
        epoch: this.epoch,
        changed: true,
        version: v,
        counts: c,
      }),
    );
  }

  commit(plan: MutationPlan, journal: CellWrite[], faults?: CommitFaults): void {
    for (let i = 0; i < plan.writes.length; i++) {
      faults?.beforeWrite?.(i, plan);
      const w = plan.writes[i]!;
      journal.push(w);
      w.cell.set(w.next);
    }
  }

  rollback(plan: MutationPlan, journal: CellWrite[], faults?: CommitFaults): void {
    for (let i = journal.length - 1; i >= 0; i--) {
      faults?.beforeUndo?.(i, plan);
      const w = journal[i]!;
      w.cell.set(w.prev);
    }
    faults?.afterRollback?.(this, plan);
  }

  shape(): unknown[] {
    return [
      this.orderTree,
      this.orderTree.size,
      this.keyById,
      this.keyById.size,
      this.customSet.size,
      this.leftCustom,
      this.leftCustom.size,
      this.version,
      this.epoch,
      this.epochStartVersion,
    ];
  }

  verifySnapshot(plan: MutationPlan, shapeBefore: unknown[]): boolean {
    for (const w of plan.writes) {
      if (!Object.is(w.cell.get(), w.prev)) return false;
    }
    const shape = this.shape();
    if (shape.some((v, i) => !Object.is(v, shapeBefore[i]))) return false;
    try {
      this.assertInvariants();
    } catch {
      return false;
    }
    return true;
  }

  assertInvariants(): void {
    const fail = (msg: string): never => {
      throw new Error(`Invariant violated: ${msg}`);
    };
    if (this.orderTree.size !== this.keyById.size) fail('I2 orderTree/keyById size');
    let prevKey: string | null = null;
    for (const [key, id] of this.orderTree.entries()) {
      if (prevKey !== null && !(prevKey < key)) fail(`I2 key order at ${key}`);
      prevKey = key;
      if (this.keyById.get(id) !== key) fail(`I2 keyById(${id}) != ${key}`);
      if (!this.exists(id)) fail(`I2 selected ID ${id} does not exist`);
      if (key.length > this.keyMaxLen) fail(`I6 key length ${key.length}`);
    }
    const blocks = this.blockFree.length;
    for (let b = 0; b < blocks; b++) {
      const start = b * BLOCK_SIZE + 1;
      const end = Math.min(this.baseMax, start + BLOCK_SIZE - 1);
      let free = 0;
      for (let id = start; id <= end; id++) {
        const bit = this.baseSelected[id]!;
        if (bit !== 0 && bit !== 1) fail(`I3 bitmap value at ${id}`);
        if ((bit === 1) !== this.keyById.has(id)) fail(`I3 bitmap/keyById mismatch at ${id}`);
        if (bit === 0) free++;
      }
      if (this.blockFree[b] !== free) fail(`I3 blockFree[${b}]`);
    }
    if (this.baseSelected[0] !== 0) fail('I3 bitmap slot 0');
    let unselectedCustom = 0;
    for (const id of this.customSet) {
      if (!(id > this.baseMax && Number.isSafeInteger(id))) fail(`I1 custom ID ${id}`);
      const selected = this.keyById.has(id);
      if (selected === this.leftCustom.has(id)) fail(`I4 leftCustom at ${id}`);
      if (!selected) unselectedCustom++;
    }
    if (this.leftCustom.size !== unselectedCustom) fail('I4 leftCustom size');
    if (!Number.isSafeInteger(this.version) || this.version < 0) fail('I7 version');
    for (let v = this.oldestLoggedVersion(); v <= this.version; v++) {
      if (this.changeLog[v % this.changeLogSize]?.v !== v) fail(`I7 change log at ${v}`);
    }
    if (this.epochStartVersion > this.version) fail('epochStartVersion ahead of version');
  }

  digest(): string {
    const h = createHash('sha256');
    h.update(this.baseSelected);
    h.update(new Uint8Array(this.blockFree.buffer));
    h.update(JSON.stringify([...this.customSet].sort((a, b) => a - b)));
    h.update(JSON.stringify(this.leftCustom.keysArray()));
    h.update(JSON.stringify(this.orderTree.toArray()));
    h.update(JSON.stringify([...this.keyById].sort((a, b) => a[0] - b[0])));
    h.update(JSON.stringify([this.version, this.epoch, this.epochStartVersion]));
    h.update(JSON.stringify(this.changeLog));
    return h.digest('hex');
  }

  loadSelectedFixture(ids: number[]): void {
    if (this.keyById.size > 0) throw new Error('fixture requires an empty selection');
    const keys = generateNKeysBetween(null, null, ids.length);
    const entries: [string, number][] = ids.map((id, i) => [keys[i]!, id]);
    this.orderTree = stringTree(entries);
    for (const [key, id] of entries) {
      this.keyById.set(id, key);
      if (this.isBase(id)) {
        this.baseSelected[id] = 1;
        this.blockFree[(id - 1) >> BLOCK_SHIFT]!--;
      } else this.leftCustom.delete(id);
    }
  }

  private blockLength(b: number): number {
    return Math.min(this.baseMax, (b + 1) * BLOCK_SIZE) - b * BLOCK_SIZE;
  }

  private orderedIds(): number[] {
    const ids: number[] = [];
    for (const [, id] of this.orderTree.entries()) ids.push(id);
    return ids;
  }

  private leftListRemoval(id: number): CellWrite[] {
    if (this.isBase(id)) {
      const block = (id - 1) >> BLOCK_SHIFT;
      return [
        this.write(this.baseSelectedCell(id), 1),
        this.write(this.blockFreeCell(block), this.blockFree[block]! - 1),
      ];
    }
    return [this.write(this.leftCustomCell(id), ABSENT)];
  }

  private placeWithRekey(
    kind: 'select' | 'reorder',
    writes: CellWrite[],
    id: number,
    oldKey: string | null,
    lo: string | null,
    hi: string | null,
    fullOrder: () => number[],
  ): Prepared {
    const window = this.rekeyWindow(oldKey, lo, hi);
    if (!window) return this.finalizeRebalanced(kind, writes, fullOrder(), id);
    const { left, right, keys } = window;
    const bodies: ChangeBody[] = [];
    const inserts: CellWrite[] = [];
    const neighbours: [string, number][] = [...left, ...right];
    const newKeys = [...keys.slice(0, left.length), ...keys.slice(left.length + 1)];
    for (let i = 0; i < neighbours.length; i++) {
      const [prev, x] = neighbours[i]!;
      const next = newKeys[i]!;
      if (prev === next) continue;
      writes.push(this.write(this.orderTreeCell(prev), ABSENT));
      inserts.push(this.write(this.orderTreeCell(next), x), this.write(this.keyByIdCell(x), next));
      bodies.push({ type: 'moved', id: x, key: next });
    }
    if (oldKey !== null) writes.push(this.write(this.orderTreeCell(oldKey), ABSENT));
    const key = keys[left.length]!;
    inserts.push(this.write(this.orderTreeCell(key), id), this.write(this.keyByIdCell(id), key));
    writes.push(...inserts);
    bodies.push(kind === 'select' ? { type: 'selected', id, key } : { type: 'moved', id, key });
    return this.finalize(kind, writes, bodies, false, (v, counts) => ({
      id,
      key,
      epoch: this.epoch,
      changed: true,
      version: v,
      counts,
    }));
  }

  private rekeyWindow(
    skipKey: string | null,
    lo: string | null,
    hi: string | null,
  ): { left: [string, number][]; right: [string, number][]; keys: string[] } | null {
    const maxSide = Math.min(this.rekeyMaxSide, Math.floor((this.changeLogSize - 1) / 2));
    if (maxSide < 1) return null;
    const goal = Math.max(2, Math.floor(this.keyMaxLen / 2));
    const tree = this.orderTree;
    const nearLeft: [string, number][] = [];
    const right: [string, number][] = [];
    let l = lo;
    let r = hi;
    for (let side = Math.min(REKEY_MIN_SIDE, maxSide); ; side = Math.min(side * 2, maxSide)) {
      while (l !== null && (l === skipKey || nearLeft.length < side)) {
        if (l !== skipKey) nearLeft.push([l, tree.get(l)!]);
        l = tree.nextLowerKey(l) ?? null;
      }
      while (r !== null && (r === skipKey || right.length < side)) {
        if (r !== skipKey) right.push([r, tree.get(r)!]);
        r = tree.nextHigherKey(r) ?? null;
      }
      const keys = generateNKeysBetween(l, r, nearLeft.length + 1 + right.length);
      let longest = 0;
      for (const k of keys) if (k.length > longest) longest = k.length;
      const last = (l === null && r === null) || side >= maxSide;
      if (longest <= goal || (last && longest <= this.keyMaxLen)) {
        return { left: nearLeft.slice().reverse(), right, keys };
      }
      if (last) return null;
    }
  }

  private finalizeRebalanced(
    kind: MutationKind,
    writes: CellWrite[],
    ids: number[],
    target: number,
  ): Prepared {
    const keys = generateNKeysBetween(null, null, ids.length);
    const entries: [string, number][] = ids.map((id, i) => [keys[i]!, id]);
    const tree = stringTree(entries);
    const map = new Map<number, string>();
    for (const [key, id] of entries) map.set(id, key);
    const key = map.get(target)!;
    const epoch = this.epoch + 1;
    writes.push(
      this.write(this.refCell('orderTree'), tree),
      this.write(this.refCell('keyById'), map),
      this.write(this.refCell('epoch'), epoch),
      this.write(this.refCell('epochStartVersion'), this.version + 1),
    );
    const change: ChangeBody =
      kind === 'select'
        ? { type: 'selected', id: target, key }
        : { type: 'moved', id: target, key };
    return this.finalize(kind, writes, [change], true, (v, counts) => ({
      id: target,
      key,
      epoch,
      changed: true,
      version: v,
      counts,
    }));
  }

  private finalize(
    kind: MutationKind,
    writes: CellWrite[],
    bodies: ChangeBody[],
    rebalanced: boolean,
    respond: (version: number, counts: Counts) => Record<string, unknown>,
  ): Prepared {
    const changes = bodies.map((body, i) => ({ ...body, v: this.version + 1 + i }) as Change);
    const v = this.version + changes.length;
    writes.push(this.write(this.refCell('version'), v));
    for (const change of changes) {
      writes.push(this.write(this.logSlotCell(change.v % this.changeLogSize), change));
    }
    const counts = this.counts();
    if (kind === 'add') counts.all += 1;
    if (kind === 'select') counts.selected += 1;
    if (kind === 'deselect') counts.selected -= 1;
    const response = { ...respond(v, counts), instance: this.instance };
    return { ok: true, plan: { kind, writes, changes, rebalanced, response } };
  }

  private noop(kind: MutationKind, body: Record<string, unknown>): Prepared {
    return {
      ok: true,
      plan: {
        kind,
        writes: [],
        changes: [],
        rebalanced: false,
        response: {
          ...body,
          version: this.version,
          counts: this.counts(),
          instance: this.instance,
        },
      },
    };
  }

  private reject(
    code: ConstructorParameters<typeof AppError>[0],
    message: string,
    details?: Record<string, unknown>,
  ): Prepared {
    return { ok: false, error: new AppError(code, message, details) };
  }

  private write(cell: Cell, next: unknown): CellWrite {
    return { cell, prev: cell.get(), next };
  }

  private baseSelectedCell(id: number): Cell {
    return {
      label: `baseSelected[${id}]`,
      get: () => this.baseSelected[id],
      set: (v) => {
        this.baseSelected[id] = v as number;
      },
    };
  }

  private blockFreeCell(block: number): Cell {
    return {
      label: `blockFree[${block}]`,
      get: () => this.blockFree[block],
      set: (v) => {
        this.blockFree[block] = v as number;
      },
    };
  }

  private customSetCell(id: number): Cell {
    return {
      label: `customSet(${id})`,
      get: () => (this.customSet.has(id) ? true : ABSENT),
      set: (v) => {
        if (v === ABSENT) this.customSet.delete(id);
        else this.customSet.add(id);
      },
    };
  }

  private leftCustomCell(id: number): Cell {
    return {
      label: `leftCustom(${id})`,
      get: () => (this.leftCustom.has(id) ? true : ABSENT),
      set: (v) => {
        if (v === ABSENT) this.leftCustom.delete(id);
        else this.leftCustom.set(id, true);
      },
    };
  }

  private orderTreeCell(key: string): Cell {
    return {
      label: `orderTree(${key})`,
      get: () => this.orderTree.get(key) ?? ABSENT,
      set: (v) => {
        if (v === ABSENT) this.orderTree.delete(key);
        else this.orderTree.set(key, v as number);
      },
    };
  }

  private keyByIdCell(id: number): Cell {
    return {
      label: `keyById(${id})`,
      get: () => this.keyById.get(id) ?? ABSENT,
      set: (v) => {
        if (v === ABSENT) this.keyById.delete(id);
        else this.keyById.set(id, v as string);
      },
    };
  }

  private logSlotCell(slot: number): Cell {
    return {
      label: `changeLog[${slot}]`,
      get: () => this.changeLog[slot],
      set: (v) => {
        this.changeLog[slot] = v as Change | undefined;
      },
    };
  }

  private refCell(
    field: 'orderTree' | 'keyById' | 'epoch' | 'epochStartVersion' | 'version',
  ): Cell {
    return {
      label: field,
      get: () => this[field],
      set: (v) => {
        (this as Record<typeof field, unknown>)[field] = v;
      },
    };
  }
}

export function validateReorderShape(input: ReorderInput): AppError | null {
  const hasAnchors =
    (input.afterId !== undefined && input.afterId !== null) ||
    (input.beforeId !== undefined && input.beforeId !== null);
  if (input.position !== undefined) {
    if (hasAnchors)
      return new AppError('INVALID_ANCHOR', 'Use either anchors or position, not both');
    return null;
  }
  if (!hasAnchors) return new AppError('INVALID_ANCHOR', 'At least one anchor is required');
  if (input.afterId === input.id || input.beforeId === input.id) {
    return new AppError('INVALID_ANCHOR', 'An item cannot be anchored to itself');
  }
  if (input.afterId !== undefined && input.afterId !== null && input.afterId === input.beforeId) {
    return new AppError('INVALID_ANCHOR', 'afterId and beforeId must differ');
  }
  return null;
}
