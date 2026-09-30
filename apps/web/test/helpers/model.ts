import { generateKeyBetween } from 'fractional-indexing';
import type {
  Change,
  ChangesResponse,
  Counts,
  ItemsPage,
  LeftItem,
  SelectedItem,
  SelectedPage,
} from '@mim/shared';

const enc = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const dec = (s: string): { pos: number | string } =>
  JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export const match = (id: number, filter: string): boolean =>
  filter === '' || String(id).includes(filter);

let instanceSeq = 0;

export class ModelServer {
  instance = `model-${++instanceSeq}`;
  custom = new Set<number>();
  selected: SelectedItem[] = [];
  version = 0;
  epoch = 0;
  log: Change[] = [];

  constructor(readonly baseMax: number) {}

  restart(): void {
    this.instance = `model-${++instanceSeq}`;
    this.custom = new Set();
    this.selected = [];
    this.version = 0;
    this.epoch = 0;
    this.log = [];
  }

  counts(): Counts {
    return { all: this.baseMax + this.custom.size, selected: this.selected.length };
  }

  exists(id: number): boolean {
    return (id >= 1 && id <= this.baseMax) || this.custom.has(id);
  }

  isSelected(id: number): boolean {
    return this.selected.some((s) => s.id === id);
  }

  leftAll(filter = ''): LeftItem[] {
    const out: LeftItem[] = [];
    const selected = new Set(this.selected.map((s) => s.id));
    for (let id = 1; id <= this.baseMax; id++) {
      if (!selected.has(id) && match(id, filter)) out.push({ id, custom: false });
    }
    for (const id of [...this.custom].sort((a, b) => a - b)) {
      if (!selected.has(id) && match(id, filter)) out.push({ id, custom: true });
    }
    return out;
  }

  rightAll(filter = ''): SelectedItem[] {
    return this.selected.filter((s) => match(s.id, filter));
  }

  private push(
    change: Change extends infer C ? (C extends Change ? Omit<C, 'v'> : never) : never,
  ): Change {
    const c = { ...change, v: ++this.version } as Change;
    this.log.push(c);
    return c;
  }

  add(id: number): boolean {
    if (this.exists(id)) return false;
    this.custom.add(id);
    this.push({ type: 'added', id });
    return true;
  }

  select(id: number): boolean {
    if (!this.exists(id) || this.isSelected(id)) return false;
    const last = this.selected[this.selected.length - 1]?.key ?? null;
    const key = generateKeyBetween(last, null);
    this.selected.push({ id, key });
    this.push({ type: 'selected', id, key });
    return true;
  }

  deselect(id: number): boolean {
    const i = this.selected.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.selected.splice(i, 1);
    this.push({ type: 'deselected', id });
    return true;
  }

  move(id: number, afterId: number | null, beforeId: number | null): boolean {
    const i = this.selected.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const rest = this.selected.filter((s) => s.id !== id);
    let at: number;
    if (afterId !== null) {
      const a = rest.findIndex((s) => s.id === afterId);
      if (a < 0) return false;
      at = a + 1;
    } else if (beforeId !== null) {
      const b = rest.findIndex((s) => s.id === beforeId);
      if (b < 0) return false;
      at = b;
    } else return false;
    if (at === i) return false;
    const key = generateKeyBetween(rest[at - 1]?.key ?? null, rest[at]?.key ?? null);
    rest.splice(at, 0, { id, key });
    this.selected = rest;
    this.push({ type: 'moved', id, key });
    return true;
  }

  itemsPage(filter: string, cursor: string | null, limit: number, budget = Infinity): ItemsPage {
    const after = cursor ? (dec(cursor).pos as number) : 0;
    const selected = new Set(this.selected.map((s) => s.id));
    const candidates = [
      ...Array.from({ length: this.baseMax }, (_, i) => i + 1),
      ...[...this.custom].sort((a, b) => a - b),
    ].filter((id) => id > after && !selected.has(id));
    const items: LeftItem[] = [];
    let scanned = 0;
    let pos = after;
    for (const id of candidates) {
      if (items.length >= limit || scanned >= budget) {
        return this.itemsResult(items, filter, pos, false, scanned);
      }
      scanned++;
      pos = id;
      if (match(id, filter)) items.push({ id, custom: id > this.baseMax });
    }
    return this.itemsResult(items, filter, pos, true, scanned);
  }

  private itemsResult(
    items: LeftItem[],
    filter: string,
    pos: number,
    done: boolean,
    scanned: number,
  ): ItemsPage {
    return {
      items,
      nextCursor: done ? null : enc({ v: 1, list: 'items', filter, pos }),
      done,
      scanned,
      version: this.version,
      counts: this.counts(),
      instance: this.instance,
    };
  }

  selectedPage(
    filter: string,
    cursor: string | null,
    limit: number,
    budget = Infinity,
  ): SelectedPage {
    const after = cursor ? (dec(cursor).pos as string) : null;
    const candidates = this.selected.filter((s) => after === null || s.key > after);
    const items: SelectedItem[] = [];
    let scanned = 0;
    let pos = after;
    const result = (done: boolean): SelectedPage => ({
      items,
      nextCursor: done ? null : enc({ v: 1, list: 'selected', filter, pos, epoch: this.epoch }),
      done,
      scanned,
      epoch: this.epoch,
      version: this.version,
      counts: this.counts(),
      instance: this.instance,
    });
    for (const s of candidates) {
      if (items.length >= limit || scanned >= budget) return result(false);
      scanned++;
      pos = s.key;
      if (match(s.id, filter)) items.push(s);
    }
    return result(true);
  }

  changes(since: number, max = 1000): ChangesResponse {
    const changes = this.log.filter((c) => c.v > since).slice(0, max);
    const toVersion = changes.length ? changes[changes.length - 1]!.v : since;
    return {
      fromVersion: since,
      toVersion,
      epoch: this.epoch,
      counts: this.counts(),
      changes,
      hasMore: toVersion < this.version,
      instance: this.instance,
    };
  }
}
