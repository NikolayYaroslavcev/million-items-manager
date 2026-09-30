import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiError, failureKind } from '../src/api/http.js';
import { SseParser } from '../src/sync/sse.js';
import { TabHub } from '../src/sync/tabs.js';
import { EventTransport, type JournalMessage } from '../src/sync/transport.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('SseParser', () => {
  it('parses events split across chunks, ignores comments, handles CRLF', () => {
    const p = new SseParser();
    const all = [
      ...p.push('retry: 2000\n\nevent: hel'),
      ...p.push('lo\ndata: {"version":1}\n\n: ping\n\n'),
      ...p.push('event: batch\r\nid: 5\r\ndata: {"a":\r'),
      ...p.push('\ndata: 1}\r\n\r\n'),
    ];
    expect(all).toEqual([
      { event: 'hello', data: '{"version":1}', id: null },
      { event: 'batch', data: '{"a":\n1}', id: '5' },
    ]);
  });
});

describe('Api', () => {
  it('retries RETRYABLE codes with the same Idempotency-Key and honours Retry-After', async () => {
    const keys: (string | null)[] = [];
    const sleeps: number[] = [];
    let n = 0;
    const api = new Api({
      fetch: async (_url, init) => {
        keys.push(new Headers(init?.headers).get('Idempotency-Key'));
        n++;
        if (n === 1) {
          return json(
            503,
            { error: { code: 'QUEUE_FULL', message: 'full' } },
            { 'Retry-After': '3' },
          );
        }
        if (n === 2) return json(504, { error: { code: 'TIMEOUT_NOT_APPLIED', message: 't' } });
        return json(200, {
          id: 1,
          key: 'a0',
          epoch: 0,
          changed: true,
          version: 7,
          counts: { all: 1, selected: 1 },
        });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const r = await api.select(1, 'key-12345678');
    expect(r.version).toBe(7);
    expect(keys).toEqual(['key-12345678', 'key-12345678', 'key-12345678']);
    expect(sleeps).toEqual([3000, 1000]);
  });

  it('does not retry a final 4xx; classifies outcomes (3.7)', async () => {
    let calls = 0;
    const api = new Api({
      fetch: async () => {
        calls++;
        return json(409, { error: { code: 'NOT_SELECTED', message: 'x' } });
      },
      sleep: async () => {},
    });
    const e = (await api
      .reorder({ id: 1, position: 'first' }, 'kkkkkkkk')
      .catch((x) => x)) as ApiError;
    expect(calls).toBe(1);
    expect(e.code).toBe('NOT_SELECTED');
    expect(failureKind(e)).toBe('rejected');
    expect(failureKind(new ApiError(500, 'INTERNAL', ''))).toBe('not_applied');
    expect(failureKind(new ApiError(500, 'OUTCOME_UNKNOWN', ''))).toBe('fatal');
    expect(failureKind(new ApiError(0, 'NETWORK', ''))).toBe('unknown');
  });

  it('network errors are retried 3 times, then reported as NETWORK (outcome unknown)', async () => {
    let calls = 0;
    const api = new Api({
      fetch: async () => {
        calls++;
        throw new TypeError('Failed to fetch');
      },
      sleep: async () => {},
    });
    const e = (await api.deselect(3, 'kkkkkkkk').catch((x) => x)) as ApiError;
    expect(calls).toBe(4);
    expect(e.code).toBe('NETWORK');
  });

  it('a client timeout aborts the request and reports TIMEOUT', async () => {
    vi.useFakeTimers();
    const api = new Api({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
      retry: { delays: [], maxDelayMs: 0 },
    });
    const p = api.request('GET', '/x', { timeoutMs: 1000 }).catch((x) => x);
    await vi.advanceTimersByTimeAsync(1001);
    expect(((await p) as ApiError).code).toBe('TIMEOUT');
    vi.useRealTimers();
  });
});

function sseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const enc = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    send(text: string) {
      controller.enqueue(enc.encode(text));
    },
    close() {
      controller.close();
    },
  };
}

const hello = (version: number, instance = 'srv-a') =>
  `retry: 2000\n\nevent: hello\ndata: ${JSON.stringify({ instance, version, epoch: 0, counts: { all: 1, selected: 0 }, nextAddInMs: 100 })}\n\n`;

describe('EventTransport', () => {
  let messages: JournalMessage[];
  let version: number | null;
  let instance: string;
  let urls: string[];
  let handler: (url: string, init?: RequestInit) => Promise<Response>;
  let transport: EventTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    messages = [];
    version = 10;
    instance = 'srv-a';
    urls = [];
  });
  afterEach(() => {
    transport?.stop();
    vi.useRealTimers();
  });

  const make = () => {
    const fetchImpl = ((url: string, init?: RequestInit) => {
      urls.push(url);
      return handler(url, init);
    }) as typeof fetch;
    transport = new EventTransport({
      api: new Api({ fetch: fetchImpl }),
      fetch: fetchImpl,
      getPosition: () => (version === null ? null : { instance, version }),
      emit: (m) => {
        messages.push(m);
        if (m.t === 'batch') version = m.data.toVersion;
      },
    });
    transport.start();
  };

  it('connects with lastEventId = instance.version of the mirror and forwards events', async () => {
    const s = sseStream();
    handler = async () => s.response;
    make();
    await vi.advanceTimersByTimeAsync(0);
    expect(urls[0]).toBe('/api/events?lastEventId=srv-a.10');
    s.send(hello(12));
    s.send(
      'event: batch\nid: srv-a.12\ndata: {"instance":"srv-a","fromVersion":10,"toVersion":12,"epoch":0,"counts":{"all":1,"selected":0},"changes":[]}\n\n',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(messages.filter((m) => m.t !== 'status').map((m) => m.t)).toEqual(['hello', 'batch']);
    expect(transport.status).toEqual({ mode: 'sse', state: 'online' });
  });

  it('T30: a silent connection (no heartbeat for 40 s) is dropped and reopened from the mirror version', async () => {
    const streams = [sseStream(), sseStream()];
    let i = 0;
    handler = async () => streams[i++]!.response;
    make();
    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.send(hello(10));
    await vi.advanceTimersByTimeAsync(15_000);
    streams[0]!.send(': ping\n\n');
    await vi.advanceTimersByTimeAsync(39_000);
    expect(urls).toHaveLength(1);
    version = 11;
    await vi.advanceTimersByTimeAsync(1_000 + 1_000);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe('/api/events?lastEventId=srv-a.11');
  });

  it('T29: SSE unreachable → polling within 25 s; back to SSE on the next probe', async () => {
    let blocked = true;
    handler = async (url) => {
      if (url.startsWith('/api/events')) {
        if (blocked) throw new TypeError('blocked');
        const s = sseStream();
        s.send(hello(version!));
        return s.response;
      }
      return json(200, {
        instance: 'srv-a',
        fromVersion: version,
        toVersion: (version ?? 0) + 1,
        epoch: 0,
        counts: { all: 1, selected: 0 },
        changes: [{ v: (version ?? 0) + 1, type: 'added', id: 2_000_000 }],
        hasMore: false,
      });
    };
    make();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(transport.status.mode).toBe('polling');
    expect(urls).toContain('/api/changes?since=10&instance=srv-a');
    const polls = urls.filter((u) => u.startsWith('/api/changes')).length;
    await vi.advanceTimersByTimeAsync(4_100);
    expect(urls.filter((u) => u.startsWith('/api/changes')).length).toBeGreaterThanOrEqual(
      polls + 2,
    );
    expect(transport.status.state).toBe('delayed');
    blocked = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.status).toEqual({ mode: 'sse', state: 'online' });
    const pollsAfter = urls.filter((u) => u.startsWith('/api/changes')).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(urls.filter((u) => u.startsWith('/api/changes')).length).toBe(pollsAfter);
  });

  it('503 SSE_LIMIT → polling at once', async () => {
    handler = async (url) =>
      url.startsWith('/api/events')
        ? json(503, { error: { code: 'SSE_LIMIT', message: 'limit' } })
        : json(200, {
            instance: 'srv-a',
            fromVersion: 10,
            toVersion: 10,
            epoch: 0,
            counts: { all: 1, selected: 0 },
            changes: [],
            hasMore: false,
          });
    make();
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.status.mode).toBe('polling');
  });

  it('no hello twice in a row → polling', async () => {
    handler = async (url) =>
      url.startsWith('/api/events')
        ? sseStream().response
        : json(200, {
            instance: 'srv-a',
            fromVersion: 10,
            toVersion: 10,
            epoch: 0,
            counts: { all: 1, selected: 0 },
            changes: [],
            hasMore: false,
          });
    make();
    await vi.advanceTimersByTimeAsync(10_000 + 1_000 + 10_000 + 100);
    expect(transport.status.mode).toBe('polling');
  });

  it('polling with a lost history emits resync at the current version', async () => {
    handler = async (url) =>
      url.startsWith('/api/events')
        ? json(503, { error: { code: 'SSE_LIMIT', message: 'limit' } })
        : json(409, {
            error: {
              code: 'HISTORY_EXPIRED',
              message: 'x',
              details: { currentVersion: 3, epoch: 0, instance: 'srv-a', reason: 'ahead' },
            },
          });
    make();
    await vi.advanceTimersByTimeAsync(10);
    expect(messages.find((m) => m.t === 'resync')).toEqual({
      t: 'resync',
      data: { instance: 'srv-a', version: 3, epoch: 0, reason: 'expired' },
    });
  });

  it('polling after a server restart: HISTORY_EXPIRED instance_changed → resync to the new instance', async () => {
    handler = async (url) =>
      url.startsWith('/api/events')
        ? json(503, { error: { code: 'SSE_LIMIT', message: 'limit' } })
        : json(409, {
            error: {
              code: 'HISTORY_EXPIRED',
              message: 'x',
              details: {
                currentVersion: 25,
                epoch: 0,
                instance: 'srv-b',
                reason: 'instance_changed',
              },
            },
          });
    make();
    await vi.advanceTimersByTimeAsync(10);
    expect(urls).toContain('/api/changes?since=10&instance=srv-a');
    expect(messages.find((m) => m.t === 'resync')).toEqual({
      t: 'resync',
      data: { instance: 'srv-b', version: 25, epoch: 0, reason: 'instance_changed' },
    });
  });

  it('reports offline when the journal has not been refreshed for 10 s', async () => {
    handler = async () => {
      throw new TypeError('down');
    };
    make();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(transport.status.state).toBe('offline');
  });
});

function browserEnv() {
  const queue: { cb: () => Promise<unknown>; release?: () => void }[] = [];
  let held = false;
  const grant = () => {
    if (held || !queue.length) return;
    const next = queue.shift()!;
    held = true;
    void Promise.resolve(next.cb()).finally(() => {
      held = false;
      grant();
    });
  };
  const locks = {
    request: (_name: string, cb: () => Promise<unknown>) =>
      new Promise((resolve) => {
        queue.push({ cb: () => Promise.resolve(cb()).then(resolve) });
        grant();
      }),
  } as unknown as LockManager;
  const channels = new Set<{ onmessage: ((e: MessageEvent) => void) | null; closed: boolean }>();
  const channelFactory = () => {
    const ch = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      closed: false,
      postMessage(data: unknown) {
        for (const other of channels) {
          if (other !== ch && !other.closed) {
            const copy = structuredClone(data);
            queueMicrotask(() => other.onmessage?.({ data: copy } as MessageEvent));
          }
        }
      },
      close() {
        ch.closed = true;
        channels.delete(ch);
      },
    };
    channels.add(ch);
    return ch as unknown as BroadcastChannel;
  };
  return { locks, channelFactory };
}

describe('TabHub (T31 logic)', () => {
  it('one leader runs the transport and forwards to the others; closing it hands over', async () => {
    const env = browserEnv();
    const started: number[] = [];
    const emitters = new Map<number, (m: JournalMessage) => void>();
    const received: JournalMessage[][] = [[], [], []];
    const hubs = [0, 1, 2].map(
      (i) =>
        new TabHub({
          sink: (m) => received[i]!.push(m),
          createTransport: (emit) => ({
            start: () => {
              started.push(i);
              emitters.set(i, emit);
            },
            stop: () => emitters.delete(i),
          }),
          describe: () => ({ hello: null, status: null }),
          locks: env.locks,
          channelFactory: env.channelFactory,
        }),
    );
    hubs.forEach((h) => h.start());
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0]);
    const batch: JournalMessage = {
      t: 'batch',
      data: {
        instance: 'srv-a',
        fromVersion: 0,
        toVersion: 1,
        epoch: 0,
        counts: { all: 1, selected: 1 },
        changes: [],
      },
    };
    emitters.get(0)!(batch);
    await new Promise((r) => setTimeout(r, 0));
    expect(received.map((r) => r.length)).toEqual([1, 1, 1]);
    hubs[0]!.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1]);
    expect(hubs[1]!.isLeader).toBe(true);
    emitters.get(1)!(batch);
    await new Promise((r) => setTimeout(r, 0));
    expect(received[2]).toHaveLength(2);
  });

  it('without Web Locks every tab is its own leader', () => {
    let started = 0;
    const hub = new TabHub({
      sink: () => {},
      createTransport: () => ({ start: () => started++, stop: () => {} }),
      describe: () => ({ hello: null, status: null }),
      locks: null,
      channelFactory: null,
    });
    hub.start();
    expect(started).toBe(1);
  });
});
