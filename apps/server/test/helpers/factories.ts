import { pino } from 'pino';
import { loadConfig, type Config } from '../../src/config.js';
import { Engine, type EngineConfig, type EngineHooks } from '../../src/core/engine.js';
import { createRuntime, type RuntimeOptions } from '../../src/runtime.js';
import { Store, type StoreOptions } from '../../src/store/store.js';
import { FakeClock } from './fakeClock.js';

export const silentLogger = pino({ level: 'silent' });

export function makeStore(overrides: Partial<StoreOptions> = {}): Store {
  return new Store({
    baseMax: 3000,
    maxCustomIds: 500_000,
    keyMaxLen: 128,
    changeLogSize: 10_000,
    instance: 'test-instance',
    ...overrides,
  });
}

export const engineDefaults: EngineConfig = {
  mainTickMs: 1000,
  addEveryTicks: 10,
  readTickBudgetMs: 250,
  mainQueueCap: 10_000,
  addQueueCap: 10_000,
  mainQueueTimeoutMs: 15_000,
  addQueueTimeoutMs: 30_000,
  scanBudget: 100_000,
  checkInvariants: true,
};

export function makeEngine(
  opts: {
    store?: Store;
    config?: Partial<EngineConfig>;
    hooks?: EngineHooks;
    start?: boolean;
  } = {},
): { engine: Engine; store: Store; clock: FakeClock } {
  const clock = new FakeClock();
  const store = opts.store ?? makeStore();
  const engine = new Engine(store, { ...engineDefaults, ...opts.config }, clock, {
    logger: silentLogger,
    ...opts.hooks,
  });
  if (opts.start !== false) engine.start();
  return { engine, store, clock };
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    BASE_MAX: '3000',
    MAIN_TICK_MS: '20',
    ADD_EVERY_TICKS: '5',
    RATE_LIMIT_ENABLED: 'false',
    CHECK_INVARIANTS: 'true',
    ...env,
  });
}

export function makeRuntime(env: Record<string, string> = {}, options: RuntimeOptions = {}) {
  return createRuntime(testConfig(env), {
    logger: silentLogger,
    exit: () => {},
    ...options,
  });
}
