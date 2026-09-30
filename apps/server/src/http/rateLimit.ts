import type { RequestHandler } from 'express';
import { fail } from '../errors.js';
import type { Clock } from '../core/clock.js';
import { sendResult } from './send.js';

export interface BucketConfig {
  perSecond: number;
  burst: number;
}

export function rateLimit(name: string, config: BucketConfig, clock: Clock): RequestHandler {
  const buckets = new Map<string, { tokens: number; at: number }>();
  let lastSweep = clock.now();

  return (req, res, next) => {
    const now = clock.now();
    if (now - lastSweep > 60_000) {
      for (const [ip, b] of buckets) {
        if (b.tokens + ((now - b.at) / 1000) * config.perSecond >= config.burst) buckets.delete(ip);
      }
      lastSweep = now;
    }
    const ip = req.ip ?? 'unknown';
    const bucket = buckets.get(ip) ?? { tokens: config.burst, at: now };
    bucket.tokens = Math.min(
      config.burst,
      bucket.tokens + ((now - bucket.at) / 1000) * config.perSecond,
    );
    bucket.at = now;
    buckets.set(ip, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      next();
      return;
    }
    const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / config.perSecond));
    sendResult(
      res,
      fail(
        'RATE_LIMITED',
        `Too many ${name} requests`,
        { retryAfterMs: retryAfter * 1000 },
        {
          'Retry-After': String(retryAfter),
        },
      ),
    );
  };
}
