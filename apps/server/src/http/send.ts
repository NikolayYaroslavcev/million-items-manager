import type { Response } from 'express';
import { IDEMPOTENT_REPLAYED_HEADER } from '@mim/shared';
import type { OpResult } from '../errors.js';

export function sendResult(res: Response, result: OpResult, replayed = false): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  if (result.headers) res.set(result.headers);
  if (replayed) res.set(IDEMPOTENT_REPLAYED_HEADER, 'true');
  res.set('Cache-Control', 'no-store');
  res.status(result.status).json(result.body);
}
