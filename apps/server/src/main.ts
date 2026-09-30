import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

const config = loadConfig();
const runtime = createRuntime(config);

process.on('SIGTERM', () => void runtime.shutdown({ exitCode: 0, reason: 'shutdown' }));
process.on('SIGINT', () => void runtime.shutdown({ exitCode: 0, reason: 'shutdown' }));
process.on('uncaughtException', (err) => {
  runtime.logger.fatal({ err }, 'uncaught exception');
  void runtime.shutdown({ exitCode: 1, reason: 'fatal' });
});

const address = await runtime.listen();
runtime.logger.info(
  { port: address.port, baseMax: config.baseMax, tickMs: config.mainTickMs },
  'server listening',
);
