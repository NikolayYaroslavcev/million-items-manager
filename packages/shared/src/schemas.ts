import { z } from 'zod';
import { FILTER_PATTERN, MAX_ID, PAGE_LIMIT_MAX } from './constants.js';

export const idSchema = z.number().int().min(1).max(MAX_ID);

export const idParamSchema = z
  .string()
  .regex(/^\d{1,16}$/, 'ID must be 1-16 decimal digits')
  .transform(Number)
  .pipe(idSchema);

export const filterSchema = z
  .string()
  .optional()
  .transform((v) => v ?? '')
  .refine((v) => v === '' || FILTER_PATTERN.test(v), 'filter must be 1-16 decimal digits');

export const limitSchema = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return PAGE_LIMIT_MAX;
    if (!/^-?\d{1,9}$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: 'limit must be an integer' });
      return z.NEVER;
    }
    return Math.min(PAGE_LIMIT_MAX, Math.max(1, Number(v)));
  });

export const pageQuerySchema = z.object({
  filter: filterSchema,
  cursor: z.string().max(2048).optional(),
  limit: limitSchema,
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export const instanceSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'invalid instance');

export const changesQuerySchema = z.object({
  since: z
    .string()
    .regex(/^\d{1,16}$/, 'since must be a non-negative integer')
    .transform(Number),
  instance: instanceSchema.optional(),
});

export const addItemBodySchema = z.strictObject({ id: idSchema });
export type AddItemBody = z.infer<typeof addItemBodySchema>;

export const selectBodySchema = z.strictObject({ id: idSchema });
export type SelectBody = z.infer<typeof selectBodySchema>;

export const reorderBodySchema = z.strictObject({
  id: idSchema,
  afterId: idSchema.nullable().optional(),
  beforeId: idSchema.nullable().optional(),
  position: z.enum(['first', 'last']).optional(),
});
export type ReorderBody = z.infer<typeof reorderBodySchema>;
