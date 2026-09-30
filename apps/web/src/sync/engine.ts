import {
  CLIENT_CHANGE_BUFFER,
  PAGE_LIMIT_MAX,
  cursorPosition,
  type BatchEvent,
  type Change,
  type Counts,
  type HelloEvent,
  type ItemsPage,
  type LeftItem,
  type SelectedItem,
  type SelectedPage,
  type Versioned,
} from '@mim/shared';
import { ApiError, failureKind, type Api } from '../api/http.js';
import { describeError, describeOp } from './messages.js';
import {
  ListMirror,
  leftSpec,
  rightSpec,
  sameBound,
  type Bound,
  type ListKind,
  type ListSpec,
} from './mirror.js';
import { opIds, type OpInput, type PendingOp } from './overlay.js';
import type { ConnectionStatus, JournalMessage } from './transport.js';

export interface Notice {
  kind: 'error' | 'info' | 'success';
  message: string;
  action?: { label: string; run(): void };
  id?: string;
}

export interface ListStatus {
  loading: boolean;
  error: string | null;
  stalled: boolean;
  scanned: number;
  resetToken: number;
}

export interface ListSnapshot<T, P> {
  filter: string;
  items: readonly T[];
  end: Bound<P>;
  status: ListStatus;
}

export interface Snapshot {
  instance: string | null;
  version: number | null;
  epoch: number | null;
  counts: Counts | null;
  connection: ConnectionStatus;
  nextAddAt: number | null;
  left: ListSnapshot<LeftItem, number>;
  right: ListSnapshot<SelectedItem, string>;
  ops: readonly PendingOp[];
  isLeader: boolean;
}

export interface EngineTiming {
  pageCatchUpMs: number;
  pageWaitMs: number;
  confirmCatchUpMs: number;
  maxEmptyResponses: number;
  maxConcurrentAdds: number;
}

export const DEFAULT_ENGINE_TIMING: EngineTiming = {
  pageCatchUpMs: 500,
  pageWaitMs: 3000,
  confirmCatchUpMs: 5000,
  maxEmptyResponses: 10,
  maxConcurrentAdds: 3,
};

export interface EngineDeps {
  api: Api;
  notify?: (notice: Notice) => void;
  now?: () => number;
  newKey?: () => string;
  timing?: Partial<EngineTiming>;
}

type AnyPage = ItemsPage | SelectedPage;

interface WaitingPage {
  page: AnyPage;
  from: Bound<unknown>;
  timers: ReturnType<typeof setTimeout>[];
}

class ListController<T extends { id: number }, P> {
  readonly mirror: ListMirror<T, P>;
  cursor: string | null = null;
  generation = 0;
  resetToken = 0;
  inflight: AbortController | null = null;
  waiting: WaitingPage | null = null;
  loading = false;
  error: string | null = null;
  stalled = false;
  scanned = 0;
  emptyStreak = 0;
  portionLeft = 0;
  refetches = 0;
  snapshot: ListSnapshot<T, P> | null = null;

  constructor(readonly spec: ListSpec<T, P>) {
    this.mirror = new ListMirror(spec);
  }

  get kind(): ListKind {
    return this.spec.kind;
  }

  restart(filter: string): void {
    this.generation++;
    this.resetToken++;
    this.inflight?.abort();
    this.inflight = null;
    this.clearWaiting();
    this.mirror.reset(filter);
    this.cursor = null;
    this.loading = false;
    this.error = null;
    this.stalled = false;
    this.scanned = 0;
    this.emptyStreak = 0;
    this.portionLeft = 0;
    this.refetches = 0;
  }

  clearWaiting(): void {
    for (const t of this.waiting?.timers ?? []) clearTimeout(t);
    this.waiting = null;
  }
}

type InstanceCheck = 'same' | 'stale' | 'switched';

export class SyncEngine {
  instance: string | null = null;
  private readonly retiredInstances = new Set<string>();
  version: number | null = null;
  epoch: number | null = null;
  counts: Counts | null = null;
  private countsVersion = -1;
  private buffer: Change[] = [];
  connection: ConnectionStatus = { mode: 'sse', state: 'connecting' };
  nextAddAt: number | null = null;
  isLeader = false;

  readonly left = new ListController(leftSpec);
  readonly right = new ListController(rightSpec);
  ops: readonly PendingOp[] = [];

  private readonly api: Api;
  private readonly timing: EngineTiming;
  private readonly now: () => number;
  private readonly newKey: () => string;
  private opSeq = 0;
  private groupSeq = 0;
  private catchingUp: Promise<void> | null = null;
  private catchUpAgain = false;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot | null = null;
  private notifyScheduled = false;
  private stopped = false;
  private opTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly stats = { resyncs: 0, catchUps: 0, merges: 0, refetches: 0, instanceChanges: 0 };

  constructor(private readonly deps: EngineDeps) {
    this.api = deps.api;
    this.timing = { ...DEFAULT_ENGINE_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.newKey = deps.newKey ?? (() => crypto.randomUUID());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => {
    if (!this.snapshot) {
      this.snapshot = {
        instance: this.instance,
        version: this.version,
        epoch: this.epoch,
        counts: this.counts,
        connection: this.connection,
        nextAddAt: this.nextAddAt,
        left: this.listSnapshot(this.left),
        right: this.listSnapshot(this.right),
        ops: this.ops,
        isLeader: this.isLeader,
      };
    }
    return this.snapshot;
  };

  private listSnapshot<T extends { id: number }, P>(c: ListController<T, P>): ListSnapshot<T, P> {
    const prev = c.snapshot;
    const status: ListStatus = {
      loading: c.loading,
      error: c.error,
      stalled: c.stalled,
      scanned: c.scanned,
      resetToken: c.resetToken,
    };
    if (
      prev &&
      prev.items === c.mirror.items &&
      prev.filter === c.mirror.filter &&
      sameBound(prev.end, c.mirror.end) &&
      shallowEqual(prev.status, status)
    ) {
      return prev;
    }
    c.snapshot = { filter: c.mirror.filter, items: c.mirror.items, end: c.mirror.end, status };
    return c.snapshot;
  }

  private changed(): void {
    this.snapshot = null;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const listener of this.listeners) listener();
    });
  }

  private notify(notice: Notice): void {
    this.deps.notify?.(notice);
  }

  start(): void {
    this.stopped = false;
    this.restartLists();
  }

  stop(): void {
    this.stopped = true;
    for (const c of [this.left, this.right]) c.restart(c.mirror.filter);
    for (const t of this.opTimers.values()) clearTimeout(t);
    this.opTimers.clear();
  }

  setLeader(isLeader: boolean): void {
    this.isLeader = isLeader;
    this.changed();
  }

  describe(): { hello: JournalMessage | null; status: ConnectionStatus } {
    const hello: JournalMessage | null =
      this.version !== null && this.instance !== null && this.counts
        ? {
            t: 'hello',
            data: {
              instance: this.instance,
              version: this.version,
              epoch: this.epoch ?? 0,
              counts: this.counts,
              nextAddInMs: this.nextAddAt === null ? 0 : Math.max(0, this.nextAddAt - this.now()),
            },
            at: this.now(),
          }
        : null;
    return { hello, status: this.connection };
  }

  receive = (message: JournalMessage): void => {
    if (this.stopped) return;
    switch (message.t) {
      case 'hello':
        return this.onHello(message.data, message.at);
      case 'batch':
        return this.ingest(message.data);
      case 'resync': {
        const d = message.data;
        if (this.retiredInstances.has(d.instance)) return;
        if (d.reason === 'instance_changed' && d.instance === this.instance) return;
        return this.resync(d.reason, { version: d.version, epoch: d.epoch, instance: d.instance });
      }
      case 'shutdown':
        this.notify({
          kind: 'info',
          id: 'shutdown',
          message: 'Сервер перезапускается — переподключаемся',
        });
        return;
      case 'status':
        this.connection = message.data;
        this.changed();
        return;
    }
  };

  private checkInstance(
    instance: string,
    base: { version: number; epoch: number | null },
  ): InstanceCheck {
    if (this.instance === instance) return 'same';
    if (this.retiredInstances.has(instance)) return 'stale';
    if (this.instance === null) {
      this.instance = instance;
      return 'same';
    }
    this.resync('instance_changed', { ...base, instance });
    return 'switched';
  }

  private onHello(hello: HelloEvent, at: number): void {
    const check = this.checkInstance(hello.instance, {
      version: hello.version,
      epoch: hello.epoch,
    });
    if (check === 'stale') return;
    this.nextAddAt = at + hello.nextAddInMs;
    if (check === 'switched') {
      this.updateCounts(hello.counts, hello.version);
      this.changed();
      return;
    }
    if (this.version === null) {
      this.version = hello.version;
      this.epoch = hello.epoch;
      this.updateCounts(hello.counts, hello.version);
      this.processWaiting();
    } else {
      this.updateCounts(hello.counts, hello.version);
      if (hello.version > this.version) {
        const target = hello.version;
        setTimeout(() => {
          if (this.version !== null && this.version < target) void this.catchUp();
        }, 1500);
      }
    }
    this.changed();
  }

  ingest(batch: BatchEvent): void {
    const check = this.checkInstance(batch.instance, {
      version: batch.toVersion,
      epoch: batch.epoch,
    });
    if (check === 'stale') return;
    if (check === 'switched') {
      this.updateCounts(batch.counts, batch.toVersion);
      return;
    }
    if (this.version === null) {
      this.version = batch.toVersion;
      this.epoch = batch.epoch;
      this.updateCounts(batch.counts, batch.toVersion);
      this.processWaiting();
      this.changed();
      return;
    }
    if (batch.toVersion <= this.version) {
      this.updateCounts(batch.counts, batch.toVersion);
      return;
    }
    if (batch.fromVersion > this.version) {
      void this.catchUp();
      return;
    }
    const fresh = batch.changes.filter((c) => c.v > this.version!);
    for (let i = 0; i < fresh.length; i++) {
      if (fresh[i]!.v !== this.version + 1 + i) {
        void this.catchUp();
        return;
      }
    }
    if (fresh.length > 0 && fresh[fresh.length - 1]!.v !== batch.toVersion) {
      void this.catchUp();
      return;
    }
    this.left.mirror.applyChanges(fresh);
    this.right.mirror.applyChanges(fresh);
    this.buffer.push(...fresh);
    if (this.buffer.length > CLIENT_CHANGE_BUFFER * 2) {
      this.buffer = this.buffer.slice(-CLIENT_CHANGE_BUFFER);
    }
    this.version = batch.toVersion;
    this.updateCounts(batch.counts, batch.toVersion);
    if (this.epoch === null) this.epoch = batch.epoch;
    else if (batch.epoch !== this.epoch) {
      this.epoch = batch.epoch;
      this.restartLists('rebalance');
    }
    this.confirmOps();
    this.processWaiting();
    this.changed();
  }

  private changesBetween(from: number, to: number): Change[] | null {
    if (from >= to) return [];
    const first = this.buffer[0];
    if (!first || first.v > from + 1) return null;
    const start = from + 1 - first.v;
    const end = to - first.v + 1;
    if (end > this.buffer.length) return null;
    return this.buffer.slice(start, end);
  }

  catchUp(): Promise<void> {
    if (this.catchingUp) {
      this.catchUpAgain = true;
      return this.catchingUp;
    }
    this.catchingUp = (async () => {
      try {
        do {
          this.catchUpAgain = false;
          this.stats.catchUps++;
          for (let round = 0; round < 50 && this.version !== null && !this.stopped; round++) {
            const since = this.version;
            const res = await this.api.getChanges(since, this.instance);
            this.ingest({
              instance: res.instance,
              fromVersion: res.fromVersion,
              toVersion: res.toVersion,
              epoch: res.epoch,
              counts: res.counts,
              changes: res.changes,
            });
            if (!res.hasMore || this.version === since) break;
          }
        } while (this.catchUpAgain && !this.stopped);
      } catch (e) {
        const error = e as ApiError;
        if (error instanceof ApiError && error.code === 'HISTORY_EXPIRED') {
          const d = error.details;
          const instance = typeof d.instance === 'string' ? d.instance : this.instance;
          const current = Number(d.currentVersion);
          if (instance !== null && !this.retiredInstances.has(instance)) {
            this.resync(d.reason === 'instance_changed' ? 'instance_changed' : 'expired', {
              version: Number.isFinite(current) ? current : 0,
              epoch: typeof d.epoch === 'number' ? d.epoch : null,
              instance,
            });
          }
        }
      } finally {
        this.catchingUp = null;
      }
    })();
    return this.catchingUp;
  }

  resync(
    reason: string,
    base?: { version: number; epoch: number | null; instance: string | null },
  ): void {
    this.stats.resyncs++;
    let lost = 0;
    if (base) {
      if (base.instance !== null && base.instance !== this.instance) {
        if (this.instance !== null) this.retiredInstances.add(this.instance);
        this.instance = base.instance;
        this.stats.instanceChanges++;
        const dead = this.ops.filter((o) => o.state === 'applied' && o.instance !== base.instance);
        for (const o of dead) this.removeOp(o.opId);
        lost = dead.length;
      }
      this.version = base.version;
      this.epoch = base.epoch;
      this.buffer = [];
      this.countsVersion = -1;
    }
    if (reason === 'instance_changed') {
      this.notify({
        kind: lost > 0 ? 'error' : 'info',
        id: 'resync',
        message:
          lost > 0
            ? `Сервер перезапущен, данные загружены заново; не сохранилось операций: ${lost}`
            : 'Сервер перезапущен — данные загружены заново',
      });
      this.restartLists();
    } else {
      this.restartLists(reason);
    }
    this.confirmOps();
    this.changed();
  }

  private restartLists(reason?: string): void {
    for (const c of [this.left, this.right] as ListController<{ id: number }, unknown>[]) {
      c.restart(c.mirror.filter);
      this.startPortion(c);
    }
    if (reason && reason !== 'initial') {
      this.notify({ kind: 'info', id: 'resync', message: 'Список обновлён' });
    }
    this.changed();
  }

  private updateCounts(counts: Counts, version: number): void {
    if (version >= this.countsVersion) {
      this.counts = counts;
      this.countsVersion = version;
    }
  }

  setFilter(list: ListKind, filter: string): void {
    const c = this.controller(list);
    if (c.mirror.filter === filter) return;
    c.restart(filter);
    this.startPortion(c);
    this.changed();
  }

  loadMore(list: ListKind): void {
    const c = this.controller(list);
    if (c.inflight || c.waiting || c.mirror.done || c.loading) return;
    c.stalled = false;
    this.startPortion(c);
  }

  retryList(list: ListKind): void {
    const c = this.controller(list);
    if (c.inflight || c.waiting) return;
    c.error = null;
    if (c.portionLeft <= 0) c.portionLeft = PAGE_LIMIT_MAX;
    void this.fetchNext(c);
  }

  private controller(list: ListKind): ListController<{ id: number }, unknown> {
    return (list === 'items' ? this.left : this.right) as ListController<{ id: number }, unknown>;
  }

  private startPortion(c: ListController<{ id: number }, unknown>): void {
    if (this.stopped || c.mirror.done) return;
    c.portionLeft = PAGE_LIMIT_MAX;
    c.emptyStreak = 0;
    void this.fetchNext(c);
  }

  private async fetchNext(c: ListController<{ id: number }, unknown>): Promise<void> {
    const generation = c.generation;
    const from = c.mirror.end;
    const controller = new AbortController();
    c.inflight = controller;
    c.loading = true;
    c.error = null;
    this.changed();
    let page: AnyPage;
    try {
      page =
        c.kind === 'items'
          ? await this.api.getItems(c.mirror.filter, c.cursor, c.portionLeft, controller.signal)
          : await this.api.getSelected(c.mirror.filter, c.cursor, c.portionLeft, controller.signal);
    } catch (e) {
      if (generation !== c.generation || this.stopped) return;
      c.inflight = null;
      c.loading = false;
      const error = e as ApiError;
      if (error.code === 'CURSOR_EXPIRED') return this.resync('cursor_expired');
      if (error.code === 'INVALID_CURSOR' || error.code === 'CURSOR_MISMATCH') {
        c.restart(c.mirror.filter);
        this.startPortion(c);
        return;
      }
      c.error = describeError(error);
      this.changed();
      return;
    }
    if (generation !== c.generation || this.stopped) return;
    c.inflight = null;
    this.acceptPage(c, page, from);
  }

  private acceptPage(
    c: ListController<{ id: number }, unknown>,
    page: AnyPage,
    from: Bound<unknown>,
  ) {
    if (!sameBound(from, c.mirror.end)) return this.refetch(c);
    const check = this.checkInstance(page.instance, {
      version: page.version,
      epoch: 'epoch' in page ? page.epoch : null,
    });
    if (check === 'stale') return this.refetch(c);
    if (check === 'switched') return;
    if (this.version === null) {
      this.version = page.version;
      if ('epoch' in page) this.epoch = page.epoch;
    }
    this.updateCounts(page.counts, page.version);
    if (page.version > this.version) {
      const timers = [
        setTimeout(() => {
          if (c.waiting?.page === page) void this.catchUp();
        }, this.timing.pageCatchUpMs),
        setTimeout(() => {
          if (c.waiting?.page === page) this.refetch(c);
        }, this.timing.pageWaitMs),
      ];
      c.waiting = { page, from, timers };
      this.changed();
      return;
    }
    this.merge(c, page, from);
  }

  private processWaiting(): void {
    for (const c of [this.left, this.right] as ListController<{ id: number }, unknown>[]) {
      const w = c.waiting;
      if (w && this.version !== null && w.page.version <= this.version) {
        c.clearWaiting();
        this.merge(c, w.page, w.from);
      }
    }
  }

  private merge(c: ListController<{ id: number }, unknown>, page: AnyPage, from: Bound<unknown>) {
    if ('epoch' in page) {
      if (this.epoch === null) this.epoch = page.epoch;
      else if (page.epoch !== this.epoch) {
        if (page.epoch < this.epoch) return this.refetch(c);
        return this.resync('epoch');
      }
    }
    const later = this.changesBetween(page.version, this.version!);
    if (later === null) return this.refetch(c);
    const to: Bound<unknown> = page.done
      ? { kind: 'all' }
      : {
          kind: 'pos',
          pos: cursorPosition(page.nextCursor!, c.kind as 'items') as unknown,
        };
    c.mirror.mergePage({ items: page.items as { id: number }[], from, to }, later);
    this.stats.merges++;
    c.refetches = 0;
    c.cursor = page.nextCursor;
    c.scanned += page.scanned;
    c.portionLeft -= page.items.length;
    c.emptyStreak = page.items.length === 0 ? c.emptyStreak + 1 : 0;
    if (!c.mirror.done && c.portionLeft > 0) {
      if (c.emptyStreak >= this.timing.maxEmptyResponses) {
        c.stalled = true;
        c.loading = false;
      } else {
        void this.fetchNext(c);
      }
    } else {
      c.loading = false;
    }
    this.changed();
  }

  private refetch(c: ListController<{ id: number }, unknown>): void {
    c.clearWaiting();
    this.stats.refetches++;
    if (++c.refetches > 3) {
      c.refetches = 0;
      return this.resync('refetch');
    }
    void this.fetchNext(c);
  }

  select(id: number, group: number | null = null): PendingOp {
    return this.enqueue({ kind: 'select', id }, group);
  }

  deselect(id: number): PendingOp {
    return this.enqueue({ kind: 'deselect', id }, null);
  }

  move(
    id: number,
    target: { afterId: number | null; beforeId: number | null } | { position: 'first' | 'last' },
    group: number | null = null,
  ): PendingOp {
    return this.enqueue({ kind: 'move', id, ...target }, group);
  }

  add(id: number): PendingOp {
    return this.enqueue({ kind: 'add', id }, null);
  }

  selectAt(id: number, target: { afterId: number | null; beforeId: number | null } | null): void {
    const group = ++this.groupSeq;
    this.select(id, group);
    if (target && (target.afterId !== null || target.beforeId !== null)) {
      this.move(id, target, group);
    }
  }

  isPendingAdd(id: number): boolean {
    return this.ops.some((op) => op.kind === 'add' && op.id === id && op.state !== 'applied');
  }

  private enqueue(input: OpInput, group: number | null, idempotencyKey?: string): PendingOp {
    const op: PendingOp = {
      ...input,
      opId: ++this.opSeq,
      idempotencyKey: idempotencyKey ?? this.newKey(),
      group,
      state: 'waiting',
      version: null,
      instance: null,
      createdAt: this.now(),
      appliedAt: null,
    };
    this.ops = [...this.ops, op];
    this.changed();
    this.pump();
    return op;
  }

  private pump(): void {
    let addsInFlight = this.ops.filter((o) => o.kind === 'add' && o.state === 'sending').length;
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i]!;
      if (op.state !== 'waiting') continue;
      const ids = opIds(op);
      const blocked = this.ops
        .slice(0, i)
        .some(
          (o) =>
            (o.state === 'waiting' || o.state === 'sending') &&
            opIds(o).some((x) => ids.includes(x)),
        );
      if (blocked) continue;
      if (op.kind === 'add') {
        if (addsInFlight >= this.timing.maxConcurrentAdds) continue;
        addsInFlight++;
      }
      this.updateOp(op.opId, { state: 'sending' });
      void this.send(op);
    }
  }

  private async send(op: PendingOp): Promise<void> {
    let r: Versioned & { epoch?: number };
    try {
      switch (op.kind) {
        case 'add':
          r = await this.api.addItem(op.id, op.idempotencyKey);
          break;
        case 'select':
          r = await this.api.select(op.id, op.idempotencyKey);
          break;
        case 'deselect':
          r = await this.api.deselect(op.id, op.idempotencyKey);
          break;
        case 'move': {
          const body =
            op.position !== undefined
              ? { id: op.id, position: op.position }
              : { id: op.id, afterId: op.afterId ?? null, beforeId: op.beforeId ?? null };
          r = await this.api.reorder(body, op.idempotencyKey);
          break;
        }
      }
    } catch (e) {
      if (this.stopped) return;
      this.fail(op, e as ApiError);
      return;
    }
    if (this.stopped) return;
    const { version, counts, instance } = r;
    const check = this.checkInstance(instance, { version, epoch: r.epoch ?? null });
    if (check === 'stale') {
      this.removeOp(op.opId);
      this.notify({
        kind: 'error',
        message: `${describeOp(op)}: сервер перезапущен, операция не сохранилась`,
        action: { label: 'Повторить', run: () => this.retry(op) },
      });
      this.pump();
      return;
    }
    this.updateCounts(counts, version);
    if (op.kind === 'add') {
      this.notify({ kind: 'success', message: `ID ${op.id} добавлен` });
    }
    if (this.version !== null && this.version >= version) {
      this.removeOp(op.opId);
    } else {
      this.updateOp(op.opId, { state: 'applied', version, instance, appliedAt: this.now() });
      this.opTimers.set(
        op.opId,
        setTimeout(() => {
          this.opTimers.delete(op.opId);
          if (this.ops.some((o) => o.opId === op.opId)) void this.catchUp();
        }, this.timing.confirmCatchUpMs),
      );
    }
    this.pump();
  }

  private fail(op: PendingOp, error: ApiError): void {
    this.removeOp(op.opId);
    if (op.group !== null) {
      const rest = this.ops.filter((o) => o.group === op.group && o.state === 'waiting');
      for (const o of rest) this.removeOp(o.opId);
    }
    const kind = failureKind(error);
    const message = `${describeOp(op)}: ${describeError(error)}`;
    if (kind === 'not_applied' || kind === 'unknown') {
      this.notify({
        kind: 'error',
        message,
        action: { label: 'Повторить', run: () => this.retry(op) },
      });
    } else if (kind === 'fatal') {
      this.notify({ kind: 'error', id: 'fatal', message });
    } else {
      this.notify({ kind: 'error', message });
    }
    this.pump();
  }

  retry(op: PendingOp): void {
    const { kind, id, afterId, beforeId, position } = op;
    this.enqueue({ kind, id, afterId, beforeId, position }, null, op.idempotencyKey);
  }

  private confirmOps(): void {
    if (this.version === null) return;
    const v = this.version;
    const done = this.ops.filter(
      (o) =>
        o.state === 'applied' &&
        o.instance === this.instance &&
        o.version !== null &&
        o.version <= v,
    );
    for (const o of done) this.removeOp(o.opId);
  }

  private updateOp(opId: number, patch: Partial<PendingOp>): void {
    this.ops = this.ops.map((o) => (o.opId === opId ? { ...o, ...patch } : o));
    this.changed();
  }

  private removeOp(opId: number): void {
    const timer = this.opTimers.get(opId);
    if (timer) clearTimeout(timer);
    this.opTimers.delete(opId);
    const next = this.ops.filter((o) => o.opId !== opId);
    if (next.length !== this.ops.length) {
      this.ops = next;
      this.changed();
    }
  }
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a) as (keyof typeof a)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
