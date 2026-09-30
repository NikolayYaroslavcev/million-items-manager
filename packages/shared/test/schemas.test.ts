import { describe, expect, it } from 'vitest';
import {
  ERROR_STATUS,
  cursorPosition,
  MAX_ID,
  NOT_APPLIED_CODES,
  addItemBodySchema,
  idParamSchema,
  pageQuerySchema,
  reorderBodySchema,
} from '../src/index.js';

describe('shared schemas', () => {
  it('ID: integer 1..MAX_SAFE_INTEGER (D1)', () => {
    expect(addItemBodySchema.safeParse({ id: 1 }).success).toBe(true);
    expect(addItemBodySchema.safeParse({ id: MAX_ID }).success).toBe(true);
    for (const id of [0, -1, 1.5, MAX_ID + 1, '5', null]) {
      expect(addItemBodySchema.safeParse({ id }).success, String(id)).toBe(false);
    }
    expect(addItemBodySchema.safeParse({ id: 1, extra: true }).success).toBe(false);
    expect(idParamSchema.parse('42')).toBe(42);
    expect(idParamSchema.safeParse('9007199254740992').success).toBe(false);
    expect(idParamSchema.safeParse('1e3').success).toBe(false);
  });

  it('page query: filter digits only, limit clamped to 1..20', () => {
    expect(pageQuerySchema.parse({})).toEqual({ filter: '', limit: 20 });
    expect(pageQuerySchema.parse({ filter: '05', limit: '500' })).toEqual({
      filter: '05',
      limit: 20,
    });
    expect(pageQuerySchema.parse({ limit: '-3' }).limit).toBe(1);
    for (const filter of ['a', ' 1', '1-', '1'.repeat(17)]) {
      expect(pageQuerySchema.safeParse({ filter }).success, filter).toBe(false);
    }
    expect(pageQuerySchema.safeParse({ limit: '2.5' }).success).toBe(false);
  });

  it('reorder body shapes', () => {
    expect(reorderBodySchema.safeParse({ id: 1, afterId: 2, beforeId: null }).success).toBe(true);
    expect(reorderBodySchema.safeParse({ id: 1, position: 'first' }).success).toBe(true);
    expect(reorderBodySchema.safeParse({ id: 1, position: 'middle' }).success).toBe(false);
  });

  it('not-applied codes are retry-safe statuses', () => {
    for (const code of NOT_APPLIED_CODES)
      expect([429, 500, 503, 504]).toContain(ERROR_STATUS[code]);
  });
});

describe('cursorPosition', () => {
  const items = 'eyJ2IjoxLCJsaXN0IjoiaXRlbXMiLCJmaWx0ZXIiOiIiLCJwb3MiOjEyMzR9';
  const selected =
    'eyJ2IjoxLCJsaXN0Ijoic2VsZWN0ZWQiLCJmaWx0ZXIiOiI3IiwicG9zIjoiYTBWfiIsImVwb2NoIjoyfQ';
  it('decodes the position the server encoded', () => {
    expect(cursorPosition(items, 'items')).toBe(1234);
    expect(cursorPosition(selected, 'selected')).toBe('a0V~');
  });
  it('rejects a cursor of another list or a malformed one', () => {
    expect(() => cursorPosition(items, 'selected')).toThrow();
    expect(() => cursorPosition('not*base64', 'items')).toThrow();
  });
});
