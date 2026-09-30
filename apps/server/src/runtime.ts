import type { Server } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { pino, type Logger } from 'pino';
import type { Config } from './config.js';
import { systemClock, type Clock } from './core/clock.js';
import { Engine, type EngineFaults } from './core/engine.js';
import { IdempotencyStore } from './core/idempotency.js';
import { SseHub } from './core/sse.js';
import { createApp } from './http/app.js';
import { Store } from './store/store.js';

export interface RuntimeOptions {
  clock?: Clock;
  logger?: Logger;
  faults?: EngineFaults;
  beforeRespond?(req: Request): void;
  exit?(code: number): void;
}

export type Runtime = ReturnType<typeof createRuntime>;

export function createRuntime(config: Config, options: RuntimeOptions = {}) {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? pino({ level: config.logLevel });
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const store = new Store({
    baseMax: config.baseMax,
    maxCustomIds: config.maxCustomIds,
    keyMaxLen: config.keyMaxLen,
    rekeyMaxSide: config.rekeyMaxSide,
    changeLogSize: config.changeLogSize,
  });
  if (config.seedSelected > 0) {
    const step = Math.floor(config.baseMax / config.seedSelected);
    const started = performance.now();
    store.loadSelectedFixture(Array.from({ length: config.seedSelected }, (_, i) => 1 + i * step));
    logger.warn(
      { selected: config.seedSelected, ms: Math.round(performance.now() - started) },
      'SEED_SELECTED fixture loaded (benchmarks only)',
    );
  }
  let shutdownPromise: Promise<void> | null = null;
  const engine = new Engine(
    store,
    {
      mainTickMs: config.mainTickMs,
      addEveryTicks: config.addEveryTicks,
      readTickBudgetMs: config.readTickBudgetMs,
      mainQueueCap: config.mainQueueCap,
      addQueueCap: config.addQueueCap,
      mainQueueTimeoutMs: config.mainQueueTimeoutMs,
      addQueueTimeoutMs: config.addQueueTimeoutMs,
      scanBudget: config.scanBudget,
      checkInvariants: config.checkInvariants,
    },
    clock,
    {
      ...(options.faults ? { faults: options.faults } : {}),
      logger,
      onFatal: (error) => {
        logger.fatal({ err: error }, 'OUTCOME_UNKNOWN: entering emergency mode');
        void shutdown({ exitCode: 1, reason: 'fatal' });
      },
    },
  );
  const idempotency = new IdempotencyStore({
    ttlMs: config.idempotencyTtlMs,
    maxEntries: config.idempotencyMax,
    clock,
  });
  const sse = new SseHub(
    engine,
    {
      maxClients: config.sseMaxClients,
      maxPerIp: config.sseMaxPerIp,
      heartbeatMs: config.sseHeartbeatMs,
      retryMs: config.sseRetryMs,
      maxBufferedBytes: 4 * 1024 * 1024,
    },
    logger,
  );
  const startedAt = clock.now();
  const app = createApp({
    config,
    engine,
    idempotency,
    sse,
    clock,
    logger,
    startedAt,
    ...(options.beforeRespond ? { beforeRespond: options.beforeRespond } : {}),
  });
  let server: Server | null = null;

  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  let stopMetrics: (() => void) | null = null;
  function startMetrics(): void {
    if (config.metricsIntervalMs <= 0) return;
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const total = monitorEventLoopDelay({ resolution: 1 });
    total.enable();
    const ms = (ns: number) => Math.round(ns / 1e4) / 100;
    metricsTimer = setInterval(() => {
      const mem = process.memoryUsage();
      logger.info(
        {
          metrics: {
            eventLoop: {
              p50Ms: ms(delay.percentile(50)),
              p99Ms: ms(delay.percentile(99)),
              maxMs: ms(delay.max),
            },
            eventLoopTotal: {
              p50Ms: ms(total.percentile(50)),
              p99Ms: ms(total.percentile(99)),
              maxMs: ms(total.max),
            },
            rssMB: Math.round(mem.rss / 1048576),
            heapUsedMB: Math.round(mem.heapUsed / 1048576),
            queues: engine.stats(),
            sseClients: sse.size,
            version: store.version,
          },
        },
        'metrics',
      );
      delay.reset();
    }, config.metricsIntervalMs);
    metricsTimer.unref();
    stopMetrics = () => {
      delay.disable();
      total.disable();
    };
  }

  async function listen(port = config.port, host = config.host): Promise<AddressInfo> {
    server = app.listen(port, host);
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    engine.start();
    startMetrics();
    return server.address() as AddressInfo;
  }

  function shutdown(opts: { exitCode: number; reason: 'shutdown' | 'fatal' }): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    const force = setTimeout(() => {
      logger.error('shutdown timed out; forcing exit');
      exit(opts.exitCode || 1);
    }, config.shutdownTimeoutMs);
    force.unref();
    shutdownPromise = (async () => {
      logger.info({ reason: opts.reason }, 'shutting down');
      if (metricsTimer) clearInterval(metricsTimer);
      stopMetrics?.();
      const closed = server
        ? new Promise<void>((resolve) => server!.close(() => resolve()))
        : Promise.resolve();
      await engine.shutdown();
      sse.close(opts.reason);
      server?.closeIdleConnections();
      await Promise.race([closed, new Promise((r) => setTimeout(r, 500).unref())]);
      server?.closeAllConnections();
      clearTimeout(force);
      logger.info('shutdown complete');
      exit(opts.exitCode);
    })();
    return shutdownPromise;
  }

  return { config, clock, logger, store, engine, idempotency, sse, app, listen, shutdown };
}
