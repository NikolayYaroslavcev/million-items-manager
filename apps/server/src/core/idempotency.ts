import { createHash } from 'node:crypto';
import { NOT_APPLIED_CODES } from '@mim/shared';
import { fail, resultCode, type OpResult } from '../errors.js';
import type { Clock } from './clock.js';

interface Entry {
  fingerprint: string;
  state: 'pending' | 'done';
  promise: Promise<OpResult>;
  result?: OpResult;
  completedAt?: number;
}

export interface IdempotencyOptions {
  ttlMs: number;
  maxEntries: number;
  clock: Clock;
}

export interface IdempotentOutcome {
  result: OpResult;
  replayed: boolean;
}

export function fingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path} ${canonicalJson(body)}`)
    .digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly completed = new Map<string, number>();

  constructor(private readonly options: IdempotencyOptions) {}

  get size(): number {
    return this.entries.size;
  }

  async run(
    key: string,
    print: string,
    execute: () => Promise<OpResult>,
  ): Promise<IdempotentOutcome> {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== print) {
        return {
          result: fail(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used with a different request',
          ),
          replayed: false,
        };
      }
      if (existing.state === 'pending') return { result: await existing.promise, replayed: false };
      return { result: existing.result!, replayed: true };
    }

    const promise = execute().catch(() => fail('INTERNAL', 'Unexpected error'));
    const entry: Entry = { fingerprint: print, state: 'pending', promise };
    this.entries.set(key, entry);
    const result = await promise;
    const code = resultCode(result);
    if (code !== null && NOT_APPLIED_CODES.has(code)) {
      this.entries.delete(key);
    } else {
      entry.state = 'done';
      entry.result = result;
      entry.completedAt = this.options.clock.now();
      this.completed.set(key, entry.completedAt);
      this.evictOverflow();
    }
    return { result, replayed: false };
  }

  private prune(): void {
    const expireBefore = this.options.clock.now() - this.options.ttlMs;
    for (const [key, completedAt] of this.completed) {
      if (completedAt > expireBefore) break;
      this.completed.delete(key);
      this.entries.delete(key);
    }
  }

  private evictOverflow(): void {
    for (const key of this.completed.keys()) {
      if (this.entries.size <= this.options.maxEntries) break;
      this.completed.delete(key);
      this.entries.delete(key);
    }
  }
}
