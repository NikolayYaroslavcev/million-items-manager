import { z } from 'zod';
import { AppError } from '../errors.js';

export type ItemsCursor = { v: 1; list: 'items'; filter: string; pos: number };
export type SelectedCursor = { v: 1; list: 'selected'; filter: string; pos: string; epoch: number };
export type Cursor = ItemsCursor | SelectedCursor;

const cursorSchema = z.discriminatedUnion('list', [
  z.strictObject({
    v: z.literal(1),
    list: z.literal('items'),
    filter: z.string().max(16),
    pos: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    v: z.literal(1),
    list: z.literal('selected'),
    filter: z.string().max(16),
    pos: z.string().min(1).max(1024),
    epoch: z.number().int().min(0),
  }),
]);

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor<L extends Cursor['list']>(
  raw: string,
  list: L,
  filter: string,
): Extract<Cursor, { list: L }> {
  let parsed: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('not base64url');
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('INVALID_CURSOR', 'Cursor cannot be decoded');
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) throw new AppError('INVALID_CURSOR', 'Cursor cannot be decoded');
  const cursor = result.data;
  if (cursor.list !== list || cursor.filter !== filter) {
    throw new AppError('CURSOR_MISMATCH', 'Cursor was issued for another list or filter', {
      cursorList: cursor.list,
      cursorFilter: cursor.filter,
    });
  }
  return cursor as Extract<Cursor, { list: L }>;
}
