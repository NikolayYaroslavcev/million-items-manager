import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers/http.js';

let s: TestServer;
beforeAll(async () => {
  s = await startServer({ MAIN_TICK_MS: '20', ADD_EVERY_TICKS: '5', BASE_MAX: '500' });
});
afterAll(() => s.close());

describe('mixed concurrent load', () => {
  it('2000 mixed requests from 200 concurrent workers', async () => {
    const statuses = new Map<number, number>();
    let seq = 0;
    const one = async () => {
      const i = seq++;
      const id = 1 + ((i * 7919) % 600);
      const r = Math.abs(Math.sin(i)) * 100;
      let res;
      if (r < 30) res = await s.req('GET', `/api/items?filter=${i % 50}`);
      else if (r < 45) res = await s.req('GET', `/api/selected?filter=${i % 9 || ''}`);
      else if (r < 65)
        res = await s.req('POST', '/api/selected', { body: { id }, key: randomUUID() });
      else if (r < 75) res = await s.req('DELETE', `/api/selected/${id}`, { key: randomUUID() });
      else if (r < 90) {
        res = await s.req('PATCH', '/api/selected/order', {
          body: { id, afterId: 1 + ((id * 31) % 500), beforeId: null },
          key: randomUUID(),
        });
      } else if (r < 97)
        res = await s.req('POST', '/api/items', { body: { id: 10_000 + (i % 300) } });
      else
        res = await s.req('GET', `/api/changes?since=${Math.max(0, s.runtime.store.version - 5)}`);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      if (res.status >= 500)
        throw new Error(`unexpected ${res.status} ${JSON.stringify(res.body)}`);
    };
    const workers = Array.from({ length: 200 }, async () => {
      for (let k = 0; k < 10; k++) await one();
    });
    await Promise.all(workers);
    console.log('status histogram', Object.fromEntries(statuses));
    expect([...statuses.keys()].every((st) => st < 500)).toBe(true);
    s.runtime.store.assertInvariants();
  });
});
