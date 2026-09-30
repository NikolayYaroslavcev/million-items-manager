import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BASE_MAX } from '@mim/shared';

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3000, 1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.string().default('1'),
  STATIC_DIR: z.string().optional(),

  BASE_MAX: int(BASE_MAX, 1),
  MAIN_TICK_MS: int(1000, 1),
  ADD_EVERY_TICKS: int(10, 1),
  SCAN_BUDGET: int(100_000, 1),
  READ_TICK_BUDGET_MS: int(250, 1),
  MAIN_QUEUE_CAP: int(10_000, 1),
  ADD_QUEUE_CAP: int(10_000, 1),
  MAIN_QUEUE_TIMEOUT_MS: int(15_000, 1),
  ADD_QUEUE_TIMEOUT_MS: int(30_000, 1),
  MAX_CUSTOM_IDS: int(500_000, 0),
  KEY_MAX_LEN: int(128, 4),
  REKEY_MAX_SIDE: int(1024, 0),
  CHANGE_LOG_SIZE: int(10_000, 1),
  IDEMPOTENCY_TTL_MS: int(10 * 60_000, 1),
  IDEMPOTENCY_MAX: int(50_000, 1),
  SSE_HEARTBEAT_MS: int(15_000, 100),
  SSE_RETRY_MS: int(2000, 100),
  SSE_MAX_CLIENTS: int(2000, 1),
  SSE_MAX_PER_IP: int(10, 1),
  SHUTDOWN_TIMEOUT_MS: int(8000, 100),
  CHECK_INVARIANTS: bool(false),
  METRICS_INTERVAL_MS: int(60_000, 0),
  DEBUG_ENDPOINTS: bool(false),
  SEED_SELECTED: int(0, 0),

  RATE_LIMIT_ENABLED: bool(true),
  RATE_READ_PER_SEC: int(20, 1),
  RATE_READ_BURST: int(40, 1),
  RATE_MUTATION_PER_SEC: int(10, 1),
  RATE_MUTATION_BURST: int(30, 1),
  RATE_ADD_PER_SEC: int(2, 1),
  RATE_ADD_BURST: int(10, 1),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  nodeEnv: Env['NODE_ENV'];
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  trustProxy: number | boolean | string;
  staticDir: string | undefined;
  baseMax: number;
  mainTickMs: number;
  addEveryTicks: number;
  scanBudget: number;
  readTickBudgetMs: number;
  mainQueueCap: number;
  addQueueCap: number;
  mainQueueTimeoutMs: number;
  addQueueTimeoutMs: number;
  maxCustomIds: number;
  keyMaxLen: number;
  rekeyMaxSide: number;
  changeLogSize: number;
  idempotencyTtlMs: number;
  idempotencyMax: number;
  sseHeartbeatMs: number;
  sseRetryMs: number;
  sseMaxClients: number;
  sseMaxPerIp: number;
  shutdownTimeoutMs: number;
  checkInvariants: boolean;
  metricsIntervalMs: number;
  debugEndpoints: boolean;
  seedSelected: number;
  rateLimit: {
    enabled: boolean;
    read: { perSecond: number; burst: number };
    mutation: { perSecond: number; burst: number };
    add: { perSecond: number; burst: number };
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    const forbidden = [
      ...(e.DEBUG_ENDPOINTS ? ['DEBUG_ENDPOINTS'] : []),
      ...(e.SEED_SELECTED > 0 ? ['SEED_SELECTED'] : []),
    ];
    if (forbidden.length > 0) {
      throw new Error(
        `Invalid configuration: ${forbidden.join(', ')} not allowed with NODE_ENV=production`,
      );
    }
  }
  const trustProxy = /^\d+$/.test(e.TRUST_PROXY)
    ? Number(e.TRUST_PROXY)
    : e.TRUST_PROXY === 'true'
      ? true
      : e.TRUST_PROXY === 'false'
        ? false
        : e.TRUST_PROXY;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy,
    staticDir: e.STATIC_DIR ?? defaultStaticDir(),
    baseMax: e.BASE_MAX,
    mainTickMs: e.MAIN_TICK_MS,
    addEveryTicks: e.ADD_EVERY_TICKS,
    scanBudget: e.SCAN_BUDGET,
    readTickBudgetMs: e.READ_TICK_BUDGET_MS,
    mainQueueCap: e.MAIN_QUEUE_CAP,
    addQueueCap: e.ADD_QUEUE_CAP,
    mainQueueTimeoutMs: e.MAIN_QUEUE_TIMEOUT_MS,
    addQueueTimeoutMs: e.ADD_QUEUE_TIMEOUT_MS,
    maxCustomIds: e.MAX_CUSTOM_IDS,
    keyMaxLen: e.KEY_MAX_LEN,
    rekeyMaxSide: e.REKEY_MAX_SIDE,
    changeLogSize: e.CHANGE_LOG_SIZE,
    idempotencyTtlMs: e.IDEMPOTENCY_TTL_MS,
    idempotencyMax: e.IDEMPOTENCY_MAX,
    sseHeartbeatMs: e.SSE_HEARTBEAT_MS,
    sseRetryMs: e.SSE_RETRY_MS,
    sseMaxClients: e.SSE_MAX_CLIENTS,
    sseMaxPerIp: e.SSE_MAX_PER_IP,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    checkInvariants: e.CHECK_INVARIANTS || e.NODE_ENV === 'development',
    metricsIntervalMs: e.METRICS_INTERVAL_MS,
    debugEndpoints: e.DEBUG_ENDPOINTS,
    seedSelected: Math.min(e.SEED_SELECTED, e.BASE_MAX),
    rateLimit: {
      enabled: e.RATE_LIMIT_ENABLED,
      read: { perSecond: e.RATE_READ_PER_SEC, burst: e.RATE_READ_BURST },
      mutation: { perSecond: e.RATE_MUTATION_PER_SEC, burst: e.RATE_MUTATION_BURST },
      add: { perSecond: e.RATE_ADD_PER_SEC, burst: e.RATE_ADD_BURST },
    },
  };
}

function defaultStaticDir(): string | undefined {
  const dir = fileURLToPath(new URL('../../web/dist', import.meta.url));
  return existsSync(dir) ? dir : undefined;
}
