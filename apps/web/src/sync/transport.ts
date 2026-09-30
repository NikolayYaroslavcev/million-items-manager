import {
  formatEventId,
  type BatchEvent,
  type ChangesResponse,
  type HelloEvent,
  type ResyncEvent,
  type ShutdownEvent,
} from '@mim/shared';
import { ApiError, type Api } from '../api/http.js';
import { readEventStream, type SseMessage } from './sse.js';

export type ConnectionState = 'connecting' | 'online' | 'delayed' | 'offline';

export interface ConnectionStatus {
  mode: 'sse' | 'polling';
  state: ConnectionState;
}

export type JournalMessage =
  | { t: 'hello'; data: HelloEvent; at: number }
  | { t: 'batch'; data: BatchEvent }
  | {
      t: 'resync';
      data: {
        instance: string;
        version: number;
        epoch: number | null;
        reason: ResyncEvent['reason'] | 'expired';
      };
    }
  | { t: 'shutdown'; data: ShutdownEvent }
  | { t: 'status'; data: ConnectionStatus };

export interface TransportTiming {
  deadAfterMs: number;
  helloTimeoutMs: number;
  noHelloAttemptsToPoll: number;
  reconnectDelaysMs: readonly number[];
  reconnectsToPoll: number;
  reconnectWindowMs: number;
  pollIntervalMs: number;
  sseProbeMs: number;
  offlineAfterMs: number;
}

export const DEFAULT_TIMING: TransportTiming = {
  deadAfterMs: 40_000,
  helloTimeoutMs: 10_000,
  noHelloAttemptsToPoll: 2,
  reconnectDelaysMs: [1000, 2000, 5000, 10_000],
  reconnectsToPoll: 3,
  reconnectWindowMs: 60_000,
  pollIntervalMs: 2000,
  sseProbeMs: 60_000,
  offlineAfterMs: 10_000,
};

export interface TransportDeps {
  api: Api;
  fetch?: typeof fetch;
  baseUrl?: string;
  getPosition(): { instance: string; version: number } | null;
  emit(message: JournalMessage): void;
  now?: () => number;
  timing?: Partial<TransportTiming>;
}

export class EventTransport {
  private readonly timing: TransportTiming;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private mode: 'sse' | 'polling' = 'sse';
  private state: ConnectionState = 'connecting';
  private stream: AbortController | null = null;
  private streaming = false;
  private stopped = true;
  private reconnectTimes: number[] = [];
  private noHelloStreak = 0;
  private delayIndex = 0;
  private lastGoodAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  readonly stats = { connects: 0, polls: 0 };

  constructor(private readonly deps: TransportDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  get status(): ConnectionStatus {
    return { mode: this.mode, state: this.state };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastGoodAt = this.now();
    this.ticker = setInterval(() => this.evaluate(), 1000);
    void this.connect(false);
  }

  stop(): void {
    this.stopped = true;
    this.stream?.abort();
    this.stream = null;
    for (const t of [this.reconnectTimer, this.pollTimer, this.probeTimer]) {
      if (t) clearTimeout(t);
    }
    this.reconnectTimer = this.pollTimer = this.probeTimer = null;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private async connect(probe: boolean): Promise<void> {
    if (this.stopped) return;
    this.stats.connects++;
    const controller = new AbortController();
    this.stream = controller;
    let gotHello = false;
    let deadTimer: ReturnType<typeof setTimeout> | null = null;
    const armDead = (): void => {
      if (deadTimer) clearTimeout(deadTimer);
      deadTimer = setTimeout(() => controller.abort(), this.timing.deadAfterMs);
    };
    const helloTimer = setTimeout(() => {
      if (!gotHello) controller.abort();
    }, this.timing.helloTimeoutMs);
    armDead();

    const position = this.deps.getPosition();
    const url =
      (this.deps.baseUrl ?? '') +
      '/api/events' +
      (position !== null
        ? `?lastEventId=${formatEventId(position.instance, position.version)}`
        : '');
    const result = await readEventStream(this.fetchImpl, url, controller.signal, {
      onActivity: () => {
        armDead();
        if (gotHello) this.markGood();
      },
      onMessage: (message) => {
        if (message.event === 'hello') {
          gotHello = true;
          clearTimeout(helloTimer);
          this.onHello();
        }
        if (this.stream === controller) this.dispatch(message);
      },
    });
    clearTimeout(helloTimer);
    if (deadTimer) clearTimeout(deadTimer);
    if (this.stopped || this.stream !== controller) return;
    this.stream = null;
    if (this.streaming) {
      this.streaming = false;
      this.evaluate();
    }
    if (!gotHello) this.noHelloStreak++;

    if (result.kind === 'refused' && result.status === 503 && result.code === 'SSE_LIMIT') {
      return this.enterPolling();
    }
    if (probe && !gotHello) {
      this.scheduleProbe();
      return;
    }
    if (this.noHelloStreak >= this.timing.noHelloAttemptsToPoll) return this.enterPolling();
    this.scheduleReconnect();
  }

  private onHello(): void {
    this.noHelloStreak = 0;
    this.delayIndex = 0;
    this.streaming = true;
    if (this.mode === 'polling') this.leavePolling();
    this.markGood();
  }

  private dispatch(message: SseMessage): void {
    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    switch (message.event) {
      case 'hello':
        this.deps.emit({ t: 'hello', data: data as HelloEvent, at: this.now() });
        break;
      case 'batch':
        this.deps.emit({ t: 'batch', data: data as BatchEvent });
        break;
      case 'resync':
        this.deps.emit({ t: 'resync', data: data as ResyncEvent });
        break;
      case 'shutdown':
        this.deps.emit({ t: 'shutdown', data: data as ShutdownEvent });
        break;
    }
  }

  private scheduleReconnect(): void {
    const now = this.now();
    this.reconnectTimes = this.reconnectTimes.filter(
      (t) => now - t < this.timing.reconnectWindowMs,
    );
    this.reconnectTimes.push(now);
    if (this.reconnectTimes.length >= this.timing.reconnectsToPoll) return this.enterPolling();
    const delays = this.timing.reconnectDelaysMs;
    const delay = delays[Math.min(this.delayIndex++, delays.length - 1)]!;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(false);
    }, delay);
  }

  private enterPolling(): void {
    if (this.stopped) return;
    this.mode = 'polling';
    this.reconnectTimes = [];
    this.noHelloStreak = 0;
    this.evaluate(true);
    this.schedulePoll(0);
    this.scheduleProbe();
  }

  private leavePolling(): void {
    this.mode = 'sse';
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.pollTimer = this.probeTimer = null;
    this.evaluate(true);
  }

  private scheduleProbe(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.mode === 'polling' && !this.stream) void this.connect(true);
    }, this.timing.sseProbeMs);
  }

  private schedulePoll(delay: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    this.stats.polls++;
    try {
      const position = this.deps.getPosition();
      let since = position?.version ?? 0;
      let instance = position?.instance ?? null;
      for (let round = 0; round < 20; round++) {
        const res = await this.deps.api.request<ChangesResponse>(
          'GET',
          `/api/changes?since=${since}` + (instance !== null ? `&instance=${instance}` : ''),
        );
        if (this.stopped || this.mode !== 'polling') return;
        this.markGood();
        this.deps.emit({
          t: 'batch',
          data: {
            instance: res.instance,
            fromVersion: res.fromVersion,
            toVersion: res.toVersion,
            epoch: res.epoch,
            counts: res.counts,
            changes: res.changes,
          },
        });
        if (!res.hasMore) break;
        since = res.toVersion;
        instance = res.instance;
      }
    } catch (e) {
      const error = e as ApiError;
      if (error instanceof ApiError && error.code === 'HISTORY_EXPIRED') {
        this.markGood();
        const d = error.details;
        const current = Number(d.currentVersion);
        if (Number.isFinite(current) && typeof d.instance === 'string') {
          this.deps.emit({
            t: 'resync',
            data: {
              instance: d.instance,
              version: current,
              epoch: typeof d.epoch === 'number' ? d.epoch : null,
              reason: d.reason === 'instance_changed' ? 'instance_changed' : 'expired',
            },
          });
        }
      }
    } finally {
      this.polling = false;
      if (!this.stopped && this.mode === 'polling') this.schedulePoll(this.timing.pollIntervalMs);
    }
  }

  private markGood(): void {
    this.lastGoodAt = this.now();
    this.evaluate();
  }

  private evaluate(force = false): void {
    let next: ConnectionState;
    const fresh = this.now() - this.lastGoodAt <= this.timing.offlineAfterMs;
    if (this.mode === 'sse' && this.streaming) next = 'online';
    else if (this.mode === 'polling' && fresh) next = 'delayed';
    else next = fresh ? 'connecting' : 'offline';
    if (next === this.state && !force) return;
    this.state = next;
    this.deps.emit({ t: 'status', data: this.status });
  }
}
