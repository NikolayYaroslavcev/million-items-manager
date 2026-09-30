import type { ReorderBody } from '@mim/shared';
import { ApiError, type Api } from '../../src/api/http.js';
import type { ModelServer } from './model.js';

type Call = {
  kind: string;
  args: unknown[];
  run: () => unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  result?: { ok: true; value: unknown } | { ok: false; error: unknown };
  signal?: AbortSignal;
};

export class FakeApi {
  calls: Call[] = [];
  auto = false;
  pageBudget = Infinity;
  mutationError: ((kind: string, args: unknown[]) => ApiError | null) | null = null;
  readonly log: { kind: string; args: unknown[] }[] = [];

  constructor(readonly server: ModelServer) {}

  asApi(): Api {
    return this as unknown as Api;
  }

  private call<T>(kind: string, args: unknown[], run: () => T, signal?: AbortSignal): Promise<T> {
    this.log.push({ kind, args });
    return new Promise<T>((resolve, reject) => {
      const call: Call = {
        kind,
        args,
        run,
        resolve: resolve as (v: unknown) => void,
        reject,
        signal,
      };
      signal?.addEventListener('abort', () => {
        this.calls = this.calls.filter((c) => c !== call);
        reject(new ApiError(0, 'ABORTED', 'Aborted'));
      });
      if (this.auto) {
        this.serve(call);
        queueMicrotask(() => this.deliver(call));
      } else this.calls.push(call);
    });
  }

  serve(call: Call): void {
    if (call.result) return;
    try {
      call.result = { ok: true, value: call.run() };
    } catch (error) {
      call.result = { ok: false, error };
    }
  }

  deliver(call: Call): void {
    this.serve(call);
    this.calls = this.calls.filter((c) => c !== call);
    if (call.signal?.aborted) return;
    const r = call.result!;
    if (r.ok) call.resolve(r.value);
    else call.reject(r.error);
  }

  async flush(rounds = 50): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      if (this.calls.length === 0) {
        await new Promise((r) => setTimeout(r, 0));
        if (this.calls.length === 0) return;
      }
      for (const c of [...this.calls]) this.deliver(c);
    }
  }

  getItems(filter: string, cursor: string | null, limit: number, signal?: AbortSignal) {
    return this.call(
      'items',
      [filter, cursor, limit],
      () => this.server.itemsPage(filter, cursor, limit, this.pageBudget),
      signal,
    );
  }

  getSelected(filter: string, cursor: string | null, limit: number, signal?: AbortSignal) {
    return this.call(
      'selected',
      [filter, cursor, limit],
      () => this.server.selectedPage(filter, cursor, limit, this.pageBudget),
      signal,
    );
  }

  getChanges(since: number, instance: string | null = null) {
    return this.call('changes', [since, instance], () => {
      const other = instance !== null && instance !== this.server.instance;
      if (other || since > this.server.version) {
        throw new ApiError(409, 'HISTORY_EXPIRED', 'expired', {
          currentVersion: this.server.version,
          epoch: this.server.epoch,
          instance: this.server.instance,
          reason: other ? 'instance_changed' : 'ahead',
        });
      }
      return this.server.changes(since);
    });
  }

  private mutation<T>(kind: string, args: unknown[], run: () => T): Promise<T> {
    return this.call(kind, args, () => {
      const error = this.mutationError?.(kind, args);
      if (error) throw error;
      return run();
    });
  }

  private ok(id: number, changed: boolean, extra: object = {}) {
    return {
      id,
      changed,
      version: this.server.version,
      counts: this.server.counts(),
      instance: this.server.instance,
      ...extra,
    };
  }

  addItem(id: number, _key: string) {
    return this.mutation('add', [id], () => {
      if (!this.server.add(id))
        throw new ApiError(409, 'ALREADY_EXISTS', 'exists', { reason: 'exists' });
      return {
        item: { id, custom: true },
        version: this.server.version,
        counts: this.server.counts(),
        instance: this.server.instance,
      };
    });
  }

  select(id: number, _key: string) {
    return this.mutation('select', [id], () => {
      if (!this.server.exists(id)) throw new ApiError(404, 'NOT_FOUND', 'not found');
      const changed = this.server.select(id);
      const key = this.server.selected.find((s) => s.id === id)!.key;
      return this.ok(id, changed, { key, epoch: this.server.epoch });
    });
  }

  deselect(id: number, _key: string) {
    return this.mutation('deselect', [id], () => this.ok(id, this.server.deselect(id)));
  }

  reorder(body: ReorderBody, _key: string) {
    return this.mutation('reorder', [body], () => {
      if (!this.server.isSelected(body.id)) throw new ApiError(409, 'NOT_SELECTED', 'not selected');
      let changed: boolean;
      if (body.position) {
        const first = this.server.selected[0]!.id;
        const last = this.server.selected[this.server.selected.length - 1]!.id;
        changed =
          body.position === 'first'
            ? first !== body.id && this.server.move(body.id, null, first)
            : last !== body.id && this.server.move(body.id, last, null);
      } else {
        for (const a of [body.afterId, body.beforeId]) {
          if (typeof a === 'number' && !this.server.isSelected(a)) {
            throw new ApiError(409, 'ANCHOR_NOT_FOUND', 'anchor');
          }
        }
        changed = this.server.move(body.id, body.afterId ?? null, body.beforeId ?? null);
      }
      const key = this.server.selected.find((s) => s.id === body.id)!.key;
      return this.ok(body.id, changed, { key, epoch: this.server.epoch });
    });
  }
}
