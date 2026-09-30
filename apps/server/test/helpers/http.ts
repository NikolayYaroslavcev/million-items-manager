import type { RuntimeOptions } from '../../src/runtime.js';
import { makeRuntime } from './factories.js';

export interface TestServer {
  base: string;
  runtime: ReturnType<typeof makeRuntime>;
  close(): Promise<void>;
  req(
    method: string,
    path: string,
    opts?: { body?: unknown; key?: string; headers?: Record<string, string>; raw?: string },
  ): Promise<{ status: number; body: any; headers: Headers }>;
}

export async function startServer(
  env: Record<string, string> = {},
  options: RuntimeOptions = {},
): Promise<TestServer> {
  const runtime = makeRuntime(env, options);
  const addr = await runtime.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    base,
    runtime,
    close: () => runtime.shutdown({ exitCode: 0, reason: 'shutdown' }),
    async req(method, path, opts = {}) {
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.body !== undefined || opts.raw !== undefined)
        headers['content-type'] = 'application/json';
      if (opts.key) headers['Idempotency-Key'] = opts.key;
      const res = await fetch(base + path, {
        method,
        headers,
        body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    },
  };
}

export interface SseEvent {
  event: string;
  id?: string;
  data: any;
}

export async function openSse(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const events: SseEvent[] = [];
  let comments = 0;
  let ended = false;
  const done = (async () => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev: Partial<SseEvent> = {};
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) comments++;
            else if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('id: ')) ev.id = line.slice(4);
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          }
          if (ev.event) events.push(ev as SseEvent);
        }
      }
    } catch {}
    ended = true;
  })();
  return {
    res,
    events,
    get comments() {
      return comments;
    },
    get ended() {
      return ended;
    },
    async waitFor(pred: (e: SseEvent) => boolean, timeoutMs = 3000): Promise<SseEvent> {
      const start = Date.now();
      for (;;) {
        const found = events.find(pred);
        if (found) return found;
        if (Date.now() - start > timeoutMs) throw new Error('SSE event timeout');
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close() {
      controller.abort();
      return done;
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
