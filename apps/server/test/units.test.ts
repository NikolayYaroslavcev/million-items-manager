import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { decodeCursor, encodeCursor } from '../src/core/cursor.js';
import { canonicalJson, fingerprint, IdempotencyStore } from '../src/core/idempotency.js';
import { AppError, fail } from '../src/errors.js';
import { FakeClock } from './helpers/fakeClock.js';

describe('IdempotencyStore', () => {
  const ok = { status: 200, body: { ok: true } };

  it('stores completed results and replays them until the TTL expires', async () => {
    const clock = new FakeClock();
    const store = new IdempotencyStore({ ttlMs: 1000, maxEntries: 10, clock });
    const exec = vi.fn(async () => ok);
    expect(await store.run('k-000001', 'a', exec)).toEqual({ result: ok, replayed: false });
    expect(await store.run('k-000001', 'a', exec)).toEqual({ result: ok, replayed: true });
    expect(exec).toHaveBeenCalledTimes(1);
    await clock.advance(1001);
    expect((await store.run('k-000001', 'a', exec)).replayed).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('drops not-applied results (429/503/504/500 INTERNAL) but keeps OUTCOME_UNKNOWN and 4xx', async () => {
    const clock = new FakeClock();
    const store = new IdempotencyStore({ ttlMs: 1000, maxEntries: 10, clock });
    for (const code of [
      'QUEUE_FULL',
      'SHUTTING_DOWN',
      'TIMEOUT_NOT_APPLIED',
      'INTERNAL',
      'RATE_LIMITED',
    ] as const) {
      await store.run(`key-${code}`, 'a', async () => fail(code, 'x'));
      expect(store.size, code).toBe(0);
    }
    for (const code of ['OUTCOME_UNKNOWN', 'NOT_FOUND', 'ORDER_CONFLICT'] as const) {
      await store.run(`key-${code}`, 'a', async () => fail(code, 'x'));
      expect((await store.run(`key-${code}`, 'a', async () => ok)).replayed).toBe(true);
    }
  });

  it('a thrown executor becomes 500 INTERNAL and is not stored', async () => {
    const store = new IdempotencyStore({ ttlMs: 1000, maxEntries: 10, clock: new FakeClock() });
    const r = await store.run('k-throw1', 'a', async () => {
      throw new Error('x');
    });
    expect(r.result.status).toBe(500);
    expect(store.size).toBe(0);
  });

  it('pending requests with the same key share one execution', async () => {
    const store = new IdempotencyStore({ ttlMs: 1000, maxEntries: 10, clock: new FakeClock() });
    let resolve!: (r: typeof ok) => void;
    const exec = vi.fn(() => new Promise<typeof ok>((r) => (resolve = r)));
    const a = store.run('k-shared', 'a', exec);
    const b = store.run('k-shared', 'a', exec);
    const c = await store.run('k-shared', 'b', exec);
    expect(c.result.status).toBe(422);
    resolve(ok);
    expect((await a).result).toBe(ok);
    expect((await b).result).toBe(ok);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest completed entries beyond the limit, never pending ones', async () => {
    const store = new IdempotencyStore({ ttlMs: 60_000, maxEntries: 3, clock: new FakeClock() });
    let resolvePending!: (r: typeof ok) => void;
    const pending = store.run('pending-1', 'a', () => new Promise((r) => (resolvePending = r)));
    for (let i = 0; i < 5; i++) await store.run(`done-${i}xxxx`, 'a', async () => ok);
    expect(store.size).toBe(3);
    expect((await store.run('done-0xxxx', 'a', async () => ok)).replayed).toBe(false);
    resolvePending(ok);
    await pending;
  });

  it('fingerprint is canonical over key order', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    expect(fingerprint('post', '/x', { a: 1, b: 2 })).toBe(
      fingerprint('POST', '/x', { b: 2, a: 1 }),
    );
    expect(fingerprint('POST', '/x', { a: 1 })).not.toBe(fingerprint('POST', '/y', { a: 1 }));
  });
});

describe('cursor', () => {
  it('round-trips and is bound to list and filter', () => {
    const c = encodeCursor({ v: 1, list: 'selected', filter: '12', pos: 'a0V', epoch: 3 });
    expect(decodeCursor(c, 'selected', '12')).toEqual({
      v: 1,
      list: 'selected',
      filter: '12',
      pos: 'a0V',
      epoch: 3,
    });
    expect(() => decodeCursor(c, 'items', '12')).toThrow(AppError);
    expect(() => decodeCursor(c, 'selected', '1')).toThrowError(/another list or filter/);
    for (const bad of [
      '',
      '!!',
      Buffer.from('{"v":2}').toString('base64url'),
      Buffer.from('nope').toString('base64url'),
    ]) {
      try {
        decodeCursor(bad, 'items', '');
        expect.unreachable();
      } catch (e) {
        expect((e as AppError).code).toBe('INVALID_CURSOR');
      }
    }
  });
});

describe('config', () => {
  it('defaults follow the plan constants', () => {
    const c = loadConfig({ NODE_ENV: 'production' });
    expect(c).toMatchObject({
      baseMax: 1_000_000,
      mainTickMs: 1000,
      addEveryTicks: 10,
      scanBudget: 100_000,
      readTickBudgetMs: 250,
      mainQueueCap: 10_000,
      addQueueCap: 10_000,
      maxCustomIds: 500_000,
      keyMaxLen: 128,
      mainQueueTimeoutMs: 15_000,
      addQueueTimeoutMs: 30_000,
      idempotencyTtlMs: 600_000,
      idempotencyMax: 50_000,
      changeLogSize: 10_000,
      sseHeartbeatMs: 15_000,
      trustProxy: 1,
      checkInvariants: false,
    });
    expect(c.rateLimit.read).toEqual({ perSecond: 20, burst: 40 });
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid configuration/);
  });

  it('refuses debug endpoints and the seed fixture in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DEBUG_ENDPOINTS: 'true' })).toThrow(
      /DEBUG_ENDPOINTS/,
    );
    expect(() => loadConfig({ NODE_ENV: 'production', SEED_SELECTED: '1000' })).toThrow(
      /SEED_SELECTED/,
    );
    const prod = loadConfig({
      NODE_ENV: 'production',
      DEBUG_ENDPOINTS: 'false',
      SEED_SELECTED: '0',
    });
    expect(prod).toMatchObject({ debugEndpoints: false, seedSelected: 0 });
    const bench = loadConfig({ NODE_ENV: 'test', DEBUG_ENDPOINTS: 'true', SEED_SELECTED: '1000' });
    expect(bench).toMatchObject({ debugEndpoints: true, seedSelected: 1000 });
  });

  it('serves the monorepo SPA build unless STATIC_DIR is set', () => {
    const staticDir = loadConfig({}).staticDir;
    if (staticDir !== undefined) {
      expect(staticDir.split(/[\\/]/).slice(-3)).toEqual(['apps', 'web', 'dist']);
    }
    expect(loadConfig({ STATIC_DIR: '/srv/spa' }).staticDir).toBe('/srv/spa');
    expect(() => loadConfig({ MAIN_TICK_MS: '0' })).toThrow(/MAIN_TICK_MS/);
  });
});
