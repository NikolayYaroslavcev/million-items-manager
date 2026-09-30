import { CHANGES_PAGE_MAX, type Change, type Counts } from '@mim/shared';
import { AppError, errorResult, fail, type OpResult } from '../errors.js';
import type { CommitFaults, MutationKind, Prepared, ReorderInput, Store } from '../store/store.js';
import type { Clock } from './clock.js';
import { encodeCursor } from './cursor.js';

export interface EngineConfig {
  mainTickMs: number;
  addEveryTicks: number;
  readTickBudgetMs: number;
  mainQueueCap: number;
  addQueueCap: number;
  mainQueueTimeoutMs: number;
  addQueueTimeoutMs: number;
  scanBudget: number;
  checkInvariants: boolean;
}

export interface EngineFaults extends CommitFaults {
  beforePrepare?(kind: MutationKind): void;
  beforeRead?(request: ReadRequest): void;
}

export interface Logger {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface BatchPublication {
  fromVersion: number;
  toVersion: number;
  epoch: number;
  counts: Counts;
  changes: Change[];
  rebalanced: boolean;
}

export interface EngineHooks {
  faults?: EngineFaults;
  onFatal?(error: unknown): void;
  logger?: Logger;
}

export type MutationInput =
  | { kind: 'select'; id: number }
  | { kind: 'deselect'; id: number }
  | { kind: 'reorder'; input: ReorderInput };

export type ReadRequest =
  | { kind: 'items'; filter: string; pos: number; limit: number }
  | { kind: 'selected'; filter: string; pos: string | null; epoch: number | null; limit: number }
  | { kind: 'changes'; since: number; instance: string | null };

export interface ReadHandle {
  promise: Promise<OpResult>;
  cancel(): void;
}

interface MutationOp {
  input: MutationInput;
  state: 'queued' | 'done';
  timer: unknown;
  resolve(result: OpResult): void;
}

interface AddOp {
  id: number;
  state: 'queued' | 'done';
  timer: unknown;
  resolveOwner(result: OpResult): void;
  joiners: ((result: OpResult) => void)[];
}

interface ReadWaiter {
  resolve(result: OpResult): void;
  timer: unknown;
}

interface ReadGroup {
  key: string;
  request: ReadRequest;
  waiters: Set<ReadWaiter>;
  dropped: boolean;
}

export class Engine {
  private readonly mutations: MutationOp[] = [];
  private queuedMutations = 0;
  private readonly pendingAdds = new Map<number, AddOp>();
  private readonly readQueue: ReadGroup[] = [];
  private readonly readGroups = new Map<string, ReadGroup>();
  private readonly listeners = new Set<(batch: BatchPublication) => void>();

  private t0 = 0;
  private lastTick = 0;
  private tickTimer: unknown = null;
  private started = false;
  private stopping = false;
  private fatal = false;
  private currentBatch: Promise<void> | null = null;

  constructor(
    readonly store: Store,
    private readonly config: EngineConfig,
    private readonly clock: Clock,
    private readonly hooks: EngineHooks = {},
  ) {
    this.t0 = clock.now();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.t0 = this.clock.now();
    this.lastTick = 0;
    this.scheduleNext();
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  get isFatal(): boolean {
    return this.fatal;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer !== null) this.clock.clearTimeout(this.tickTimer);
    this.tickTimer = null;
    if (this.currentBatch) await this.currentBatch;
    const result = shuttingDown();
    for (const op of this.mutations) {
      if (op.state === 'queued') this.finishMutation(op, result);
    }
    this.mutations.length = 0;
    for (const op of this.pendingAdds.values()) this.finishAdd(op, result, result);
    this.pendingAdds.clear();
    for (const group of this.readQueue) {
      if (!group.dropped) this.finishReadGroup(group, result);
    }
    this.readQueue.length = 0;
    this.readGroups.clear();
  }

  onBatch(listener: (batch: BatchPublication) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stats(): { main: number; add: number } {
    return { main: this.mainQueueSize(), add: this.pendingAdds.size };
  }

  nextAddInMs(): number {
    const every = this.config.addEveryTicks;
    const nextAddTick = (Math.floor(this.lastTick / every) + 1) * every;
    const due = this.t0 + nextAddTick * this.config.mainTickMs;
    return Math.max(0, Math.ceil(due - this.clock.now()));
  }

  submitAdd(id: number): Promise<OpResult> {
    if (this.stopping) return Promise.resolve(shuttingDown());
    const store = this.store;
    if (store.exists(id)) {
      return Promise.resolve(
        fail('ALREADY_EXISTS', `ID ${id} already exists`, { id, reason: 'exists' }),
      );
    }
    const joined = this.pendingAdds.get(id);
    if (joined) {
      return new Promise((resolve) => joined.joiners.push(resolve));
    }
    if (store.customCount + this.pendingAdds.size >= store.maxCustomIds) {
      return Promise.resolve(
        fail('CUSTOM_LIMIT_REACHED', 'Custom ID limit reached', { limit: store.maxCustomIds }),
      );
    }
    if (this.pendingAdds.size >= this.config.addQueueCap) {
      const retryAfter = Math.max(1, Math.ceil(this.nextAddInMs() / 1000));
      return Promise.resolve(
        fail(
          'QUEUE_FULL',
          'Add queue is full',
          { retryAfterMs: retryAfter * 1000 },
          {
            'Retry-After': String(retryAfter),
          },
        ),
      );
    }
    return new Promise((resolve) => {
      const op: AddOp = {
        id,
        state: 'queued',
        timer: null,
        resolveOwner: resolve,
        joiners: [],
      };
      op.timer = this.clock.setTimeout(() => {
        if (op.state !== 'queued') return;
        this.pendingAdds.delete(id);
        const timeout = timedOut();
        this.finishAdd(op, timeout, timeout);
      }, this.config.addQueueTimeoutMs);
      this.pendingAdds.set(id, op);
    });
  }

  submitMutation(input: MutationInput): Promise<OpResult> {
    if (this.stopping) return Promise.resolve(shuttingDown());
    if (this.mainQueueSize() >= this.config.mainQueueCap) return Promise.resolve(queueFull());
    return new Promise((resolve) => {
      const op: MutationOp = { input, state: 'queued', timer: null, resolve };
      op.timer = this.clock.setTimeout(() => {
        if (op.state !== 'queued') return;
        this.queuedMutations--;
        this.finishMutation(op, timedOut());
      }, this.config.mainQueueTimeoutMs);
      this.mutations.push(op);
      this.queuedMutations++;
    });
  }

  submitRead(request: ReadRequest): ReadHandle {
    if (this.stopping) return { promise: Promise.resolve(shuttingDown()), cancel: () => {} };
    const key = JSON.stringify(request);
    let group = this.readGroups.get(key);
    if (!group) {
      if (this.mainQueueSize() >= this.config.mainQueueCap) {
        return { promise: Promise.resolve(queueFull()), cancel: () => {} };
      }
      group = { key, request, waiters: new Set(), dropped: false };
      this.readGroups.set(key, group);
      this.readQueue.push(group);
    }
    const g = group;
    let waiter!: ReadWaiter;
    const promise = new Promise<OpResult>((resolve) => {
      waiter = { resolve, timer: null };
    });
    waiter.timer = this.clock.setTimeout(() => {
      if (!g.waiters.delete(waiter)) return;
      waiter.resolve(timedOut());
      this.dropIfUnwatched(g);
    }, this.config.mainQueueTimeoutMs);
    g.waiters.add(waiter);
    return {
      promise,
      cancel: () => {
        if (!g.waiters.delete(waiter)) return;
        this.clock.clearTimeout(waiter.timer);
        this.dropIfUnwatched(g);
      },
    };
  }

  private scheduleNext(): void {
    if (this.stopping) return;
    const due = this.t0 + (this.lastTick + 1) * this.config.mainTickMs;
    const delay = Math.max(0, due - this.clock.now());
    this.tickTimer = this.clock.setTimeout(() => this.onTimer(), delay);
  }

  private onTimer(): void {
    this.tickTimer = null;
    if (this.stopping) return;
    const elapsed = this.clock.now() - this.t0;
    const tick = Math.max(this.lastTick + 1, Math.floor(elapsed / this.config.mainTickMs + 1e-9));
    const every = this.config.addEveryTicks;
    const isAddTick = Math.floor(tick / every) > Math.floor(this.lastTick / every);
    this.lastTick = tick;
    this.currentBatch = this.runBatch(isAddTick).finally(() => {
      this.currentBatch = null;
      this.scheduleNext();
    });
  }

  async runBatch(isAddTick: boolean): Promise<void> {
    const store = this.store;
    const fromVersion = store.version;
    const fromEpoch = store.epoch;
    const changes: Change[] = [];

    if (isAddTick) this.runAddPhase(changes);
    if (!this.fatal) this.runMutationPhase(changes);
    if (changes.length > 0) {
      this.publish({
        fromVersion,
        toVersion: changes[changes.length - 1]!.v,
        epoch: store.epoch,
        counts: store.counts(),
        changes,
        rebalanced: store.epoch !== fromEpoch,
      });
    }
    if (this.fatal) return;
    if (this.config.checkInvariants) {
      try {
        store.assertInvariants();
      } catch (error) {
        this.hooks.logger?.error({ err: error }, 'invariant violated after batch');
        this.fatal = true;
        this.stopping = true;
        queueMicrotask(() => this.hooks.onFatal?.(error));
        return;
      }
    }
    await this.runReadPhase();
  }

  private runAddPhase(changes: Change[]): void {
    const ops = [...this.pendingAdds.values()];
    for (const op of ops) {
      if (this.fatal) return;
      if (op.state !== 'queued') continue;
      this.pendingAdds.delete(op.id);
      const result = this.execute('add', () => this.store.prepareAdd(op.id), changes);
      const joinerResult =
        result.status === 201
          ? fail('ALREADY_EXISTS', `ID ${op.id} was added by a concurrent request`, {
              id: op.id,
              reason: 'concurrent',
            })
          : result;
      this.finishAdd(op, result, joinerResult);
    }
  }

  private runMutationPhase(changes: Change[]): void {
    const count = this.mutations.length;
    const batch = this.mutations.splice(0, count);
    for (let i = 0; i < batch.length; i++) {
      const op = batch[i]!;
      if (this.fatal) {
        this.mutations.unshift(...batch.slice(i));
        return;
      }
      if (op.state !== 'queued') continue;
      this.queuedMutations--;
      this.finishMutation(op, this.executeMutation(op.input, changes));
    }
  }

  private executeMutation(input: MutationInput, changes: Change[]): OpResult {
    const store = this.store;
    switch (input.kind) {
      case 'select': {
        const result = this.execute('select', () => store.prepareSelect(input.id), changes);
        if (result.status === 404 && this.pendingAdds.has(input.id)) {
          const retryAfterMs = this.nextAddInMs();
          return fail(
            'ITEM_PENDING',
            `ID ${input.id} is waiting to be added`,
            { id: input.id, retryAfterMs },
            { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
          );
        }
        return result;
      }
      case 'deselect':
        return this.execute('deselect', () => store.prepareDeselect(input.id), changes);
      case 'reorder':
        return this.execute('reorder', () => store.prepareReorder(input.input), changes);
    }
  }

  private execute(kind: MutationKind, prepare: () => Prepared, changes: Change[]): OpResult {
    const faults = this.hooks.faults;
    let prepared: Prepared;
    try {
      faults?.beforePrepare?.(kind);
      prepared = prepare();
    } catch (error) {
      this.hooks.logger?.error({ err: error, kind }, 'prepare failed; state untouched');
      return internalError();
    }
    if (!prepared.ok) return errorResult(prepared.error);
    const plan = prepared.plan;
    if (plan.writes.length === 0) return { status: 200, body: plan.response };

    const journal: typeof plan.writes = [];
    const shape = this.store.shape();
    try {
      this.store.commit(plan, journal, faults);
    } catch (error) {
      let proven = false;
      try {
        this.store.rollback(plan, journal, faults);
        proven = this.store.verifySnapshot(plan, shape);
      } catch (rollbackError) {
        this.hooks.logger?.error({ err: rollbackError, kind }, 'rollback failed');
      }
      if (proven) {
        this.hooks.logger?.error({ err: error, kind }, 'commit failed; rolled back and verified');
        return internalError();
      }
      this.hooks.logger?.error({ err: error, kind }, 'commit outcome unknown; emergency stop');
      this.fatal = true;
      this.stopping = true;
      queueMicrotask(() => this.hooks.onFatal?.(error));
      return fail(
        'OUTCOME_UNKNOWN',
        'Operation outcome cannot be determined; the server is restarting',
      );
    }
    changes.push(...plan.changes);
    return { status: kind === 'add' ? 201 : 200, body: plan.response };
  }

  private async runReadPhase(): Promise<void> {
    const count = this.readQueue.length;
    const started = this.clock.now();
    for (let i = 0; i < count; i++) {
      if (i > 0 && this.clock.now() - started >= this.config.readTickBudgetMs) return;
      const group = this.readQueue.shift()!;
      if (group.dropped) continue;
      this.readGroups.delete(group.key);
      group.dropped = true;
      let result: OpResult;
      try {
        this.hooks.faults?.beforeRead?.(group.request);
        result = this.executeRead(group.request);
      } catch (error) {
        this.hooks.logger?.error({ err: error }, 'read failed');
        result = internalError();
      }
      this.finishReadGroup(group, result);
      await this.clock.yield();
    }
  }

  private executeRead(request: ReadRequest): OpResult {
    const store = this.store;
    const budget = this.config.scanBudget;
    switch (request.kind) {
      case 'items': {
        const r = store.readLeft(request.filter, request.pos, request.limit, budget);
        return ok({
          items: r.items,
          nextCursor:
            r.nextPos === null
              ? null
              : encodeCursor({ v: 1, list: 'items', filter: request.filter, pos: r.nextPos }),
          done: r.done,
          scanned: r.scanned,
          version: store.version,
          counts: store.counts(),
          instance: store.instance,
        });
      }
      case 'selected': {
        if (request.epoch !== null && request.epoch !== store.epoch) {
          return errorResult(
            new AppError('CURSOR_EXPIRED', 'Order keys were rebalanced; reload the list', {
              epoch: store.epoch,
            }),
          );
        }
        const r = store.readRight(request.filter, request.pos, request.limit, budget);
        return ok({
          items: r.items,
          nextCursor:
            r.nextPos === null
              ? null
              : encodeCursor({
                  v: 1,
                  list: 'selected',
                  filter: request.filter,
                  pos: r.nextPos,
                  epoch: store.epoch,
                }),
          done: r.done,
          scanned: r.scanned,
          epoch: store.epoch,
          version: store.version,
          counts: store.counts(),
          instance: store.instance,
        });
      }
      case 'changes': {
        const r =
          request.instance !== null && request.instance !== store.instance
            ? ({ ok: false, reason: 'instance_changed' } as const)
            : store.changesSince(request.since, CHANGES_PAGE_MAX);
        if (!r.ok) {
          return fail('HISTORY_EXPIRED', 'Requested history is not available; resync', {
            currentVersion: store.version,
            epoch: store.epoch,
            instance: store.instance,
            reason: r.reason,
          });
        }
        return ok({
          fromVersion: request.since,
          toVersion: r.toVersion,
          epoch: store.epoch,
          counts: store.counts(),
          changes: r.changes,
          hasMore: r.hasMore,
          instance: store.instance,
        });
      }
    }
  }

  private publish(batch: BatchPublication): void {
    for (const listener of this.listeners) {
      try {
        listener(batch);
      } catch (error) {
        this.hooks.logger?.error({ err: error }, 'batch listener failed');
      }
    }
  }

  private mainQueueSize(): number {
    return this.queuedMutations + this.readGroups.size;
  }

  private dropIfUnwatched(group: ReadGroup): void {
    if (group.waiters.size > 0 || group.dropped) return;
    group.dropped = true;
    this.readGroups.delete(group.key);
  }

  private finishMutation(op: MutationOp, result: OpResult): void {
    op.state = 'done';
    this.clock.clearTimeout(op.timer);
    op.resolve(result);
  }

  private finishAdd(op: AddOp, ownerResult: OpResult, joinerResult: OpResult): void {
    op.state = 'done';
    this.clock.clearTimeout(op.timer);
    op.resolveOwner(ownerResult);
    for (const resolve of op.joiners) resolve(joinerResult);
  }

  private finishReadGroup(group: ReadGroup, result: OpResult): void {
    group.dropped = true;
    for (const waiter of group.waiters) {
      this.clock.clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    group.waiters.clear();
  }
}

function ok(body: unknown): OpResult {
  return { status: 200, body };
}

function shuttingDown(): OpResult {
  return fail(
    'SHUTTING_DOWN',
    'Server is shutting down; the operation was not applied',
    {},
    {
      'Retry-After': '5',
    },
  );
}

function queueFull(): OpResult {
  return fail(
    'QUEUE_FULL',
    'Queue is full; the operation was not applied',
    { retryAfterMs: 1000 },
    {
      'Retry-After': '1',
    },
  );
}

function timedOut(): OpResult {
  return fail('TIMEOUT_NOT_APPLIED', 'Operation timed out in the queue and was not applied');
}

function internalError(): OpResult {
  return fail('INTERNAL', 'Unexpected error; the operation was not applied');
}
