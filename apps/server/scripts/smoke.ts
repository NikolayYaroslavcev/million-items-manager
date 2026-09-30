import { randomUUID } from 'node:crypto';
import { connect } from 'node:http2';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const long = process.argv.includes('--long');
let failures = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  const t = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function api(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

interface Stream {
  events: { event: string; id?: string; data: any }[];
  comments: number;
  close(): void;
}

async function openStream(lastEventId?: string): Promise<Stream> {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, {
    headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {},
    signal: controller.signal,
  });
  assert(res.ok && res.body, `events status ${res.status}`);
  const stream: Stream = { events: [], comments: 0, close: () => controller.abort() };
  void (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: any = {};
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) stream.comments++;
            else if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('id: ')) ev.id = line.slice(4);
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          }
          if (ev.event) stream.events.push(ev);
        }
      }
    } catch {}
  })();
  return stream;
}

async function waitFor<T>(fn: () => T | undefined, ms: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const id = 2_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

await check('1. /api/health is 200', async () => {
  const r = await api('GET', '/api/health');
  assert(r.status === 200 && r.body.status === 'ok', `status ${r.status}`);
});

await check('2. first pages ≤ 20 items within 1.5 s', async () => {
  for (const path of ['/api/items', '/api/selected']) {
    const t = Date.now();
    const r = await api('GET', path);
    assert(r.status === 200, `${path} ${r.status}`);
    assert(r.body.items.length <= 20, `${path} returned ${r.body.items.length}`);
    assert(Date.now() - t <= 1500, `${path} took ${Date.now() - t} ms`);
  }
});

await check('3. add new ID → 201 within 11 s; repeat → 409 at once', async () => {
  const t = Date.now();
  const r = await api('POST', '/api/items', { id }, randomUUID());
  assert(r.status === 201, `add ${r.status}`);
  assert(Date.now() - t <= 11_000, `add took ${Date.now() - t} ms`);
  const t2 = Date.now();
  const dup = await api('POST', '/api/items', { id });
  assert(dup.status === 409 && Date.now() - t2 < 1000, `dup ${dup.status} ${Date.now() - t2} ms`);
});

let sseVersion = '0';
let instance = '';
await check(
  '4+5. select / reorder / deselect; SSE batch arrives ≤ 2 s after the mutation',
  async () => {
    const stream = await openStream();
    const hello = await waitFor(
      () => stream.events.find((e) => e.event === 'hello'),
      5000,
      'hello',
    );
    const sel = await api('POST', '/api/selected', { id }, randomUUID());
    assert(sel.status === 200, `select ${sel.status}`);
    const t = Date.now();
    await waitFor(
      () => stream.events.find((e) => e.event === 'batch' && e.data.toVersion >= sel.body.version),
      2000,
      'batch event',
    );
    assert(Date.now() - t <= 2000, 'event late');
    const mv = await api('PATCH', '/api/selected/order', { id, position: 'first' }, randomUUID());
    assert(mv.status === 200, `reorder ${mv.status}`);
    const list = await api('GET', '/api/selected?limit=1');
    assert(list.body.items[0]?.id === id, 'reordered item is not first');
    const del = await api('DELETE', `/api/selected/${id}`, undefined, randomUUID());
    assert(del.status === 200 && del.body.changed, `deselect ${del.status}`);
    sseVersion = String(hello.data.version);
    instance = hello.data.instance;
    const health = await api('GET', '/api/health');
    assert(instance && health.body.instance === instance, 'hello/health instance mismatch');
    assert(sel.body.instance === instance, 'mutation answer without the instance');
    const batch = stream.events.find((e) => e.event === 'batch')!;
    assert(batch.id === `${instance}.${batch.data.toVersion}`, `event id ${batch.id}`);
    stream.close();
  },
);

await check(
  '7+8. reconnect with Last-Event-ID replays; /api/changes returns the same log',
  async () => {
    const stream = await openStream(`${instance}.${sseVersion}`);
    const batch = await waitFor(
      () => stream.events.find((e) => e.event === 'batch'),
      5000,
      'replay',
    );
    stream.close();
    const versions = batch.data.changes.map((c: { v: number }) => c.v);
    versions.forEach((v: number, i: number) =>
      assert(v === Number(sseVersion) + i + 1, 'version gap'),
    );
    const changes = await api('GET', `/api/changes?since=${sseVersion}&instance=${instance}`);
    assert(changes.status === 200, `changes ${changes.status}`);
    const same =
      JSON.stringify(changes.body.changes.slice(0, versions.length)) ===
      JSON.stringify(batch.data.changes);
    assert(same, 'SSE replay differs from /api/changes');
  },
);

await check(
  '11. a Last-Event-ID / since of another server instance → resync, never replay',
  async () => {
    const stream = await openStream(`00000000-0000-4000-8000-000000000000.1`);
    const r = await waitFor(
      () => stream.events.find((e) => e.event === 'resync' || e.event === 'batch'),
      5000,
      'resync',
    );
    stream.close();
    assert(r.event === 'resync' && r.data.reason === 'instance_changed', `got ${r.event}`);
    const stale = await api(
      'GET',
      '/api/changes?since=1&instance=00000000-0000-4000-8000-000000000000',
    );
    assert(
      stale.status === 409 && stale.body.error.details.reason === 'instance_changed',
      `changes ${stale.status}`,
    );
  },
);

await check('9. responses are compressed (SSE is not); HTTP/2 via ALPN on https', async () => {
  const res = await fetch(`${base}/api/items?filter=1`, {
    headers: { 'Accept-Encoding': 'gzip, br' },
  });
  await res.arrayBuffer();
  assert(res.headers.get('content-encoding'), 'no content-encoding on /api/items');
  if (base.startsWith('https://')) {
    const protocol = await new Promise<string>((resolve, reject) => {
      const session = connect(base);
      session.once('connect', () => {
        resolve(session.alpnProtocol ?? '');
        session.close();
      });
      session.once('error', reject);
    });
    assert(protocol === 'h2', `ALPN ${protocol}`);
  }
});

await check('10. security headers present', async () => {
  const r = await api('GET', '/api/health');
  for (const h of ['content-security-policy', 'x-content-type-options', 'referrer-policy']) {
    assert(r.headers.get(h), `missing ${h}`);
  }
});

if (long) {
  await check('6. SSE stays open 5 min without mutations; heartbeat every 15 s', async () => {
    const stream = await openStream();
    await new Promise((r) => setTimeout(r, 5 * 60_000));
    assert(stream.comments >= 19, `only ${stream.comments} heartbeats`);
    stream.close();
  });
} else {
  console.log('skip 6. (5-minute idle SSE) — run with --long');
}

console.log(failures === 0 ? '\nsmoke passed' : `\nsmoke FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
