import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

type Kind = 'read' | 'mutation' | 'add';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
}
const DURATION_S = Number(args.get('duration') ?? 60);
const CONNECTIONS = Number(args.get('connections') ?? 200);
const RATE_LIMIT = (args.get('rate-limit') ?? 'off') === 'on';
const OUT = args.get('out');
const EXTRA_ENV = Object.fromEntries(
  (args.get('env') ?? '')
    .split(',')
    .filter(Boolean)
    .map((kv) => kv.split('=') as [string, string]),
);
const CLIENT_TIMEOUT_MS = 30_000;
const UNIVERSE = 5000;
const HOT = 1;

let child: ChildProcess | null = null;
const serverMetrics: {
  t: number;
  eventLoop: { p50Ms: number; p99Ms: number; maxMs: number };
  eventLoopTotal: { p50Ms: number; p99Ms: number; maxMs: number };
  rssMB: number;
  heapUsedMB: number;
  queues: { main: number; add: number };
}[] = [];
const serverErrors: unknown[] = [];

async function startServer(): Promise<string> {
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  const main = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  child = spawn(process.execPath, ['--max-old-space-size=384', main], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      DEBUG_ENDPOINTS: 'true',
      METRICS_INTERVAL_MS: '1000',
      RATE_LIMIT_ENABLED: RATE_LIMIT ? 'true' : 'false',
      STATIC_DIR: '',
      ...EXTRA_ENV,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let buffer = '';
  const listening = new Promise<void>((resolve, reject) => {
    child!.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
    child!.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let entry: { msg?: string; level?: number; metrics?: never; time?: number };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.msg === 'server listening') resolve();
        if (entry.msg === 'metrics' && entry.metrics) {
          serverMetrics.push({
            t: entry.time ?? Date.now(),
            ...(entry.metrics as object),
          } as never);
        }
        if ((entry.level ?? 0) >= 50) serverErrors.push(entry);
      }
    });
  });
  await listening;
  return `http://127.0.0.1:${port}`;
}

const BASE = args.get('base') ?? (await startServer());
const agent = new http.Agent({ keepAlive: true, maxSockets: CONNECTIONS + 5 });

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      BASE + path,
      {
        method,
        agent,
        headers: {
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        timeout: CLIENT_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { unparsable: text.slice(0, 200) };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: json });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('CLIENT_TIMEOUT')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const replica = {
  instance: '',
  version: -1,
  selected: new Map<number, string>(),
  custom: new Set<number>(),
  log: new Map<number, { type: string; id: number }>(),
  batches: 0,
  gaps: 0,
  resyncs: 0,
  lastBatchAt: 0,
  maxBatchGapMs: 0,
  initialSelected: 0,
  measuring: false,
};

function applyChange(c: { v: number; type: string; id: number; key?: string }): void {
  replica.log.set(c.v, { type: c.type, id: c.id });
  if (c.type === 'selected' || c.type === 'moved') replica.selected.set(c.id, c.key!);
  else if (c.type === 'deselected') replica.selected.delete(c.id);
  else if (c.type === 'added') replica.custom.add(c.id);
}

let sseReq: http.ClientRequest | null = null;
function openReplica(): Promise<void> {
  return new Promise((resolve, reject) => {
    sseReq = http.get(BASE + '/api/events', { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`SSE ${res.statusCode}`));
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = '';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;
          const d = JSON.parse(data);
          if (event === 'hello') {
            replica.instance = d.instance;
            replica.version = d.version;
            replica.initialSelected = d.counts.selected;
            resolve();
          } else if (event === 'batch') {
            const now = Date.now();
            if (replica.measuring && replica.lastBatchAt) {
              replica.maxBatchGapMs = Math.max(replica.maxBatchGapMs, now - replica.lastBatchAt);
            }
            replica.lastBatchAt = now;
            replica.batches++;
            if (d.instance !== replica.instance || d.fromVersion !== replica.version) {
              replica.gaps++;
            }
            for (const c of d.changes) applyChange(c);
            replica.version = d.toVersion;
          } else if (event === 'resync') {
            replica.resyncs++;
          }
        }
      });
    });
    sseReq.on('error', reject);
  });
}

const latencies: Record<Kind, number[]> = { read: [], mutation: [], add: [] };
const outcomes = new Map<string, number>();
const violations: string[] = [];
const expectedJournal: { v: number; type: string; id: number }[] = [];
let replaysChecked = 0;
const bump = (k: string) => outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
const violation = (msg: string) => {
  if (violations.length < 50) violations.push(msg);
};

function record(kind: Kind, res: Res | Error, ms: number): void {
  latencies[kind].push(ms);
  if (res instanceof Error) {
    bump(`${kind} ${res.message === 'CLIENT_TIMEOUT' ? 'TIMEOUT' : 'NETWORK ' + res.message}`);
    return;
  }
  const code = res.body?.error?.code ?? '';
  bump(`${kind} ${res.status}${code ? ' ' + code : ''}`);
  if (res.status >= 500 && res.status !== 503) violation(`${res.status} ${code}`);
  if (res.status === 429 || res.status === 503) {
    const ra = res.headers['retry-after'];
    if (typeof ra !== 'string' || !/^\d+$/.test(ra)) violation(`${res.status} without Retry-After`);
  }
  if (res.status >= 200 && res.status < 300 && res.body?.instance !== replica.instance) {
    violation(`2xx with instance ${res.body?.instance}`);
  }
}

async function timed(kind: Kind, run: () => Promise<Res>): Promise<Res | null> {
  const t = performance.now();
  try {
    const res = await run();
    record(kind, res, performance.now() - t);
    return res;
  } catch (e) {
    record(kind, e as Error, performance.now() - t);
    return null;
  }
}

const rnd = (n: number) => Math.floor(Math.random() * n);
const FILTERS = ['', '', '1', '7', '42', '123', '999', '5000', '999999', '12345'];
const TYPE_OF: Record<string, string> = {
  select: 'selected',
  deselect: 'deselected',
  reorder: 'moved',
  add: 'added',
};

async function mutate(op: string, method: string, path: string, body?: unknown): Promise<void> {
  const key = randomUUID();
  const kind: Kind = op === 'add' ? 'add' : 'mutation';
  const res = await timed(kind, () => request(method, path, body, { 'Idempotency-Key': key }));
  if (!res || res.status >= 300) return;
  const b = res.body;
  const changed = op === 'add' || b.changed === true;
  if (changed) {
    const id = op === 'add' ? b.item.id : b.id;
    expectedJournal.push({ v: b.version, type: TYPE_OF[op]!, id });
  }
  if (Math.random() < 0.05) {
    const again = await timed(kind, () => request(method, path, body, { 'Idempotency-Key': key }));
    if (again && again.status < 300) {
      replaysChecked++;
      if (again.headers['idempotent-replayed'] !== 'true') violation('replay without header');
      if (JSON.stringify(again.body) !== JSON.stringify(b)) violation('replay body differs');
    }
  }
}

async function worker(w: number, deadline: number): Promise<void> {
  let addSeq = 0;
  type Cursor = { list: string; filter: string; cursor: string };
  let cursor: Cursor | null = null;
  while (Date.now() < deadline) {
    const r = Math.random();
    if (r < 0.62) {
      if (cursor && Math.random() < 0.5) {
        const c: Cursor = cursor;
        cursor = null;
        const res = await timed('read', () =>
          request('GET', `/api/${c.list}?filter=${c.filter}&cursor=${c.cursor}`),
        );
        if (res?.status === 200 && res.body.nextCursor)
          cursor = { ...c, cursor: res.body.nextCursor };
      } else if (r < 0.05) {
        const since = Math.max(0, replica.version - rnd(500));
        await timed('read', () =>
          request('GET', `/api/changes?since=${since}&instance=${replica.instance}`),
        );
      } else {
        const list = Math.random() < 0.65 ? 'items' : 'selected';
        const filter = FILTERS[rnd(FILTERS.length)]!;
        const res = await timed('read', () => request('GET', `/api/${list}?filter=${filter}`));
        if (res?.status === 200 && res.body.nextCursor) {
          cursor = { list, filter, cursor: res.body.nextCursor };
        }
      }
    } else if (r < 0.8) {
      await mutate('select', 'POST', '/api/selected', { id: 2 + rnd(UNIVERSE - 1) });
    } else if (r < 0.88) {
      await mutate('deselect', 'DELETE', `/api/selected/${2 + rnd(UNIVERSE - 1)}`);
    } else if (r < 0.98) {
      const id = 2 + rnd(UNIVERSE - 1);
      const q = Math.random();
      const body =
        q < 0.4
          ? { id, afterId: HOT }
          : q < 0.6
            ? { id, position: Math.random() < 0.5 ? 'first' : 'last' }
            : { id, afterId: 2 + rnd(UNIVERSE - 1), beforeId: null };
      if (body.afterId === id) continue;
      await mutate('reorder', 'PATCH', '/api/selected/order', body);
    } else {
      await mutate('add', 'POST', '/api/items', { id: 2_000_000 + w * 100_000 + ++addSeq });
    }
  }
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
}
const summary = (xs: number[]) => ({
  count: xs.length,
  avgMs: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0,
  p50Ms: pct(xs, 50),
  p95Ms: pct(xs, 95),
  p99Ms: pct(xs, 99),
  maxMs: Math.round(Math.max(0, ...xs)),
});

let exitCode = 0;
try {
  await openReplica();
  if (replica.initialSelected > 0) {
    const t = performance.now();
    const initial = (await request('GET', '/api/debug/state')).body;
    if (initial.version !== replica.version) throw new Error('state moved before the load');
    for (const [id, key] of initial.selected as [number, string][]) replica.selected.set(id, key);
    console.log(
      `replica: ${replica.selected.size} seeded items (${Math.round(performance.now() - t)} ms)`,
    );
  }
  await request('POST', '/api/selected', { id: HOT });
  console.log(`load: ${CONNECTIONS} connections, ${DURATION_S} s, rate limit ${RATE_LIMIT}`);
  const started = Date.now();
  const deadline = started + DURATION_S * 1000;
  replica.measuring = true;
  setTimeout(() => (replica.measuring = false), DURATION_S * 1000).unref();
  await Promise.all(Array.from({ length: CONNECTIONS }, (_, w) => worker(w, deadline)));
  const elapsedS = DURATION_S;

  const health = (await request('GET', '/api/health')).body;
  for (let i = 0; i < 50 && replica.version < health.version; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const inv = (await request('GET', '/api/debug/invariants')).body;
  const state = (await request('GET', '/api/debug/state')).body;
  const serverOrder = (state?.selected ?? []) as [number, string][];
  const replicaOrder = [...replica.selected].sort((a, b) =>
    a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  const stateMatches =
    state?.version === replica.version &&
    JSON.stringify(serverOrder) === JSON.stringify(replicaOrder) &&
    JSON.stringify(state.custom) === JSON.stringify([...replica.custom].sort((a, b) => a - b));
  let journalMismatches = 0;
  for (const e of expectedJournal) {
    const c = replica.log.get(e.v);
    if (!c || c.type !== e.type || c.id !== e.id) journalMismatches++;
  }
  if (journalMismatches) violation(`${journalMismatches} responses disagree with the journal`);
  if (replica.gaps) violation(`${replica.gaps} SSE version gaps`);
  if (!inv?.ok) violation(`invariants: ${inv?.error ?? 'endpoint unavailable'}`);
  if (!stateMatches) violation('SSE replica differs from the server state');

  const all = [...latencies.read, ...latencies.mutation, ...latencies.add];
  const loadEnd = started + DURATION_S * 1000 + 1000;
  const steady = serverMetrics.filter((m) => m.t > started + 1000 && m.t <= loadEnd);
  const report = {
    date: new Date().toISOString(),
    node: process.version,
    config: {
      connections: CONNECTIONS,
      durationS: DURATION_S,
      rateLimit: RATE_LIMIT,
      serverEnv: EXTRA_ENV,
      base: BASE,
      initialSelected: replica.initialSelected,
    },
    throughput: {
      requests: all.length,
      reqPerSec: Math.round(all.length / elapsedS),
      readsPerSec: Math.round(latencies.read.length / elapsedS),
      mutationsPerSec: Math.round(latencies.mutation.length / elapsedS),
    },
    latency: {
      read: summary(latencies.read),
      mutation: summary(latencies.mutation),
      add: summary(latencies.add),
    },
    outcomes: Object.fromEntries([...outcomes].sort()),
    idempotentReplaysChecked: replaysChecked,
    sse: {
      batches: replica.batches,
      gaps: replica.gaps,
      resyncs: replica.resyncs,
      maxGapBetweenBatchesMs: replica.maxBatchGapMs,
      journalEntries: replica.log.size,
      extraEntries: replica.log.size - expectedJournal.length,
    },
    server: steady.length
      ? {
          windows: steady.length,
          eventLoopP99MsMax: Math.max(...steady.map((m) => m.eventLoop.p99Ms)),
          eventLoopP99MsAvg:
            Math.round((steady.reduce((a, m) => a + m.eventLoop.p99Ms, 0) / steady.length) * 100) /
            100,
          windowsWithP99Over50ms: steady.filter((m) => m.eventLoop.p99Ms > 50).length,
          eventLoopP50MsAvg:
            Math.round((steady.reduce((a, m) => a + m.eventLoop.p50Ms, 0) / steady.length) * 100) /
            100,
          eventLoopMaxMs: Math.max(...steady.map((m) => m.eventLoop.maxMs)),
          rssMBMax: Math.max(...steady.map((m) => m.rssMB)),
          heapUsedMBMax: Math.max(...steady.map((m) => m.heapUsedMB)),
          queueMainMax: Math.max(...steady.map((m) => m.queues.main)),
          errorLogLines: serverErrors.length,
        }
      : null,
    finalState: {
      version: health.version,
      epoch: health.epoch,
      invariants: inv,
      replicaMatchesServer: stateMatches,
      selected: serverOrder.length,
      custom: state?.custom?.length,
      responsesCheckedAgainstJournal: expectedJournal.length,
    },
    violations,
    passed: violations.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) exitCode = 1;
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  (sseReq as http.ClientRequest | null)?.destroy();
  agent.destroy();
  (child as ChildProcess | null)?.kill();
}
process.exit(exitCode);
