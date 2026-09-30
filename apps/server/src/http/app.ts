import { existsSync } from 'node:fs';
import path from 'node:path';
import compression from 'compression';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger as PinoLogger } from 'pino';
import type { z } from 'zod';
import {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  addItemBodySchema,
  changesQuerySchema,
  idParamSchema,
  pageQuerySchema,
  reorderBodySchema,
  selectBodySchema,
  type HealthResponse,
} from '@mim/shared';
import type { Config } from '../config.js';
import type { Clock } from '../core/clock.js';
import { decodeCursor } from '../core/cursor.js';
import type { Engine, ReadRequest } from '../core/engine.js';
import { fingerprint, type IdempotencyStore } from '../core/idempotency.js';
import type { SseHub } from '../core/sse.js';
import { AppError, errorResult, fail, type OpResult } from '../errors.js';
import { validateReorderShape } from '../store/store.js';
import { rateLimit } from './rateLimit.js';
import { sendResult } from './send.js';

export interface AppDeps {
  config: Config;
  engine: Engine;
  idempotency: IdempotencyStore;
  sse: SseHub;
  clock: Clock;
  logger: PinoLogger;
  startedAt: number;
  beforeRespond?(req: Request): void;
}

export function createApp(deps: AppDeps): express.Express {
  const { config, engine, idempotency, sse, clock } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use(
    pinoHttp({
      logger: deps.logger,
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'connect-src': ["'self'"], 'img-src': ["'self'", 'data:'] },
      },
    }),
  );
  app.use(
    compression({
      threshold: 256,
      filter: (req, res) => req.path !== '/api/events' && compression.filter(req, res),
    }),
  );
  app.use(express.json({ limit: '1kb', strict: true }));

  const limit = (name: string, bucket: { perSecond: number; burst: number }): RequestHandler =>
    config.rateLimit.enabled ? rateLimit(name, bucket, clock) : (_req, _res, next) => next();
  const readLimit = limit('read', config.rateLimit.read);
  const mutationLimit = limit('mutation', config.rateLimit.mutation);
  const addLimit = limit('add', config.rateLimit.add);

  app.get('/api/health', (_req, res) => {
    const body: HealthResponse = {
      status: engine.isStopping ? 'shutting_down' : 'ok',
      uptimeSec: Math.round((clock.now() - deps.startedAt) / 1000),
      version: engine.store.version,
      epoch: engine.store.epoch,
      instance: engine.store.instance,
      queues: engine.stats(),
    };
    res.set('Cache-Control', 'no-store');
    res.status(engine.isStopping ? 503 : 200).json(body);
  });

  const queuedRead = (req: Request, res: Response, request: ReadRequest): Promise<void> => {
    const handle = engine.submitRead(request);
    res.on('close', () => {
      if (!res.writableFinished) handle.cancel();
    });
    return handle.promise.then((result) => send(req, res, result));
  };

  app.get('/api/items', readLimit, async (req, res) => {
    const q = parse(pageQuerySchema, req.query);
    const pos = q.cursor ? decodeCursor(q.cursor, 'items', q.filter).pos : 0;
    await queuedRead(req, res, { kind: 'items', filter: q.filter, pos, limit: q.limit });
  });

  app.get('/api/selected', readLimit, async (req, res) => {
    const q = parse(pageQuerySchema, req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor, 'selected', q.filter) : null;
    await queuedRead(req, res, {
      kind: 'selected',
      filter: q.filter,
      pos: cursor?.pos ?? null,
      epoch: cursor?.epoch ?? null,
      limit: q.limit,
    });
  });

  app.get('/api/changes', readLimit, async (req, res) => {
    const q = parse(changesQuerySchema, req.query);
    await queuedRead(req, res, {
      kind: 'changes',
      since: q.since,
      instance: q.instance ?? null,
    });
  });

  const mutation = async (
    req: Request,
    res: Response,
    execute: () => Promise<OpResult>,
  ): Promise<void> => {
    const key = req.get(IDEMPOTENCY_HEADER);
    if (key === undefined) {
      send(req, res, await execute());
      return;
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new AppError('VALIDATION_ERROR', 'Idempotency-Key must be 8-128 chars [A-Za-z0-9_-]');
    }
    const print = fingerprint(req.method, req.path, req.body ?? null);
    const outcome = await idempotency.run(key, print, execute);
    send(req, res, outcome.result, outcome.replayed);
  };

  app.post('/api/items', addLimit, async (req, res) => {
    const body = parse(addItemBodySchema, req.body);
    await mutation(req, res, () => engine.submitAdd(body.id));
  });

  app.post('/api/selected', mutationLimit, async (req, res) => {
    const body = parse(selectBodySchema, req.body);
    await mutation(req, res, () => engine.submitMutation({ kind: 'select', id: body.id }));
  });

  app.delete('/api/selected/:id', mutationLimit, async (req, res) => {
    const id = parse(idParamSchema, req.params.id);
    await mutation(req, res, () => engine.submitMutation({ kind: 'deselect', id }));
  });

  app.patch('/api/selected/order', mutationLimit, async (req, res) => {
    const body = parse(reorderBodySchema, req.body);
    const invalid = validateReorderShape(body);
    if (invalid) throw invalid;
    await mutation(req, res, () => engine.submitMutation({ kind: 'reorder', input: body }));
  });

  app.get('/api/events', (req, res) => {
    const header = req.get('Last-Event-ID');
    const query = typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined;
    const refused = sse.connect(res, req.ip ?? 'unknown', header ?? query);
    if (refused) sendResult(res, refused);
  });

  if (config.debugEndpoints) {
    app.get('/api/debug/invariants', (_req, res) => {
      const started = performance.now();
      let error: string | null = null;
      try {
        engine.store.assertInvariants();
      } catch (e) {
        error = (e as Error).message;
      }
      res.json({
        ok: error === null,
        error,
        ms: Math.round(performance.now() - started),
        instance: engine.store.instance,
        version: engine.store.version,
        epoch: engine.store.epoch,
        counts: engine.store.counts(),
      });
    });
    app.get('/api/debug/state', (_req, res) => {
      const store = engine.store;
      res.json({
        instance: store.instance,
        version: store.version,
        epoch: store.epoch,
        selected: store.orderTree.toArray().map(([key, id]) => [id, key]),
        custom: [...store.customSet].sort((a, b) => a - b),
      });
    });
  }

  app.use('/api', (_req, _res, next) => {
    next(new AppError('ROUTE_NOT_FOUND', 'Unknown API route'));
  });

  if (config.staticDir && existsSync(config.staticDir)) {
    const root = path.resolve(config.staticDir);
    app.use(
      '/assets',
      express.static(path.join(root, 'assets'), { immutable: true, maxAge: '1y', index: false }),
    );
    app.use(express.static(root, { index: false, maxAge: 0 }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(root, 'index.html'));
    });
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return sendResult(res, errorResult(err));
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed' || e?.type === 'entity.too.large') {
      return sendResult(res, fail('VALIDATION_ERROR', 'Malformed or oversized JSON body'));
    }
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      return sendResult(res, fail('VALIDATION_ERROR', 'Bad request'));
    }
    req.log?.error({ err }, 'unhandled error');
    sendResult(res, fail('INTERNAL', 'Unexpected error; the operation was not applied'));
  });

  function send(req: Request, res: Response, result: OpResult, replayed = false): void {
    try {
      deps.beforeRespond?.(req);
    } catch (error) {
      req.log?.error({ err: error }, 'respond stage failed');
      res.destroy();
      return;
    }
    sendResult(res, result, replayed);
  }

  return app;
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid request', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}
