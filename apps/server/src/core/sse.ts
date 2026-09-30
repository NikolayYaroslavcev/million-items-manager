import type { ServerResponse } from 'node:http';
import {
  formatEventId,
  parseEventId,
  type BatchEvent,
  type HelloEvent,
  type ResyncEvent,
  type ShutdownEvent,
} from '@mim/shared';
import { fail, type OpResult } from '../errors.js';
import type { BatchPublication, Engine, Logger } from './engine.js';

export interface SseOptions {
  maxClients: number;
  maxPerIp: number;
  heartbeatMs: number;
  retryMs: number;
  maxBufferedBytes: number;
}

interface SseClient {
  res: ServerResponse;
  ip: string;
}

export class SseHub {
  private readonly clients = new Set<SseClient>();
  private readonly perIp = new Map<string, number>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly options: SseOptions,
    private readonly logger?: Logger,
  ) {
    this.unsubscribe = engine.onBatch((batch) => this.onBatch(batch));
  }

  get size(): number {
    return this.clients.size;
  }

  connect(res: ServerResponse, ip: string, lastEventId: string | undefined): OpResult | null {
    if (this.closed || this.engine.isStopping) {
      return fail('SHUTTING_DOWN', 'Server is shutting down', {}, { 'Retry-After': '5' });
    }
    const fromIp = this.perIp.get(ip) ?? 0;
    if (this.clients.size >= this.options.maxClients || fromIp >= this.options.maxPerIp) {
      return fail(
        'SSE_LIMIT',
        'Too many event streams; use GET /api/changes polling',
        {
          maxClients: this.options.maxClients,
          maxPerIp: this.options.maxPerIp,
        },
        { 'Retry-After': '60' },
      );
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const client: SseClient = { res, ip };
    this.clients.add(client);
    this.perIp.set(ip, fromIp + 1);
    res.on('close', () => this.remove(client));
    this.ensureHeartbeat();

    res.write(`retry: ${this.options.retryMs}\n\n`);
    const store = this.engine.store;
    const hello: HelloEvent = {
      instance: store.instance,
      version: store.version,
      epoch: store.epoch,
      counts: store.counts(),
      nextAddInMs: this.engine.nextAddInMs(),
    };
    this.send(client, 'hello', hello);
    this.replay(client, lastEventId);
    return null;
  }

  close(reason: ShutdownEvent['reason']): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of [...this.clients]) {
      this.send(client, 'shutdown', { reason } satisfies ShutdownEvent);
      client.res.end();
      this.remove(client);
    }
  }

  private replay(client: SseClient, lastEventId: string | undefined): void {
    const parsed = lastEventId === undefined ? null : parseEventId(lastEventId);
    if (!parsed) return;
    const store = this.engine.store;
    const resync = (reason: ResyncEvent['reason']): void =>
      this.send(
        client,
        'resync',
        { instance: store.instance, epoch: store.epoch, version: store.version, reason },
        store.version,
      );
    if (parsed.instance !== null && parsed.instance !== store.instance) {
      return resync('instance_changed');
    }
    const last = parsed.version;
    if (last === store.version) return;
    if (last > store.version) return resync('version_ahead');
    if (last < store.epochStartVersion) return resync('rebalance');
    const r = store.changesSince(last, Number.MAX_SAFE_INTEGER);
    if (!r.ok) return resync('history_expired');
    const batch: BatchEvent = {
      instance: store.instance,
      fromVersion: last,
      toVersion: store.version,
      epoch: store.epoch,
      counts: store.counts(),
      changes: r.changes,
    };
    this.send(client, 'batch', batch, store.version);
  }

  private onBatch(batch: BatchPublication): void {
    if (this.clients.size === 0) return;
    const { rebalanced, ...rest } = batch;
    const instance = this.engine.store.instance;
    const event: BatchEvent = { instance, ...rest };
    const frame = this.frame('batch', event, batch.toVersion);
    const resync = rebalanced
      ? this.frame(
          'resync',
          {
            instance,
            epoch: batch.epoch,
            version: batch.toVersion,
            reason: 'rebalance',
          } satisfies ResyncEvent,
          batch.toVersion,
        )
      : '';
    for (const client of [...this.clients]) this.write(client, frame + resync);
  }

  private send(client: SseClient, event: string, data: unknown, id?: number): void {
    this.write(client, this.frame(event, data, id));
  }

  private frame(event: string, data: unknown, version?: number): string {
    const id =
      version === undefined ? '' : `id: ${formatEventId(this.engine.store.instance, version)}\n`;
    return `event: ${event}\n${id}data: ${JSON.stringify(data)}\n\n`;
  }

  private write(client: SseClient, chunk: string): void {
    if (client.res.writableEnded || client.res.destroyed) return this.remove(client);
    if (client.res.writableLength > this.options.maxBufferedBytes) {
      this.logger?.warn({ ip: client.ip }, 'dropping slow SSE client');
      client.res.destroy();
      return this.remove(client);
    }
    try {
      client.res.write(chunk);
    } catch (error) {
      this.logger?.warn({ err: error, ip: client.ip }, 'SSE write failed');
      client.res.destroy();
      this.remove(client);
    }
  }

  private remove(client: SseClient): void {
    if (!this.clients.delete(client)) return;
    const n = (this.perIp.get(client.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(client.ip);
    else this.perIp.set(client.ip, n);
    if (this.clients.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const client of [...this.clients]) this.write(client, ': ping\n\n');
    }, this.options.heartbeatMs);
    this.heartbeat.unref();
  }
}
