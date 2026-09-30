export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  INVALID_CURSOR: 400,
  CURSOR_MISMATCH: 400,
  INVALID_ANCHOR: 400,
  NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  ITEM_PENDING: 409,
  NOT_SELECTED: 409,
  ANCHOR_NOT_FOUND: 409,
  ORDER_CONFLICT: 409,
  CURSOR_EXPIRED: 409,
  HISTORY_EXPIRED: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  CUSTOM_LIMIT_REACHED: 422,
  RATE_LIMITED: 429,
  QUEUE_FULL: 503,
  SHUTTING_DOWN: 503,
  SSE_LIMIT: 503,
  TIMEOUT_NOT_APPLIED: 504,
  INTERNAL: 500,
  OUTCOME_UNKNOWN: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export const NOT_APPLIED_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'QUEUE_FULL',
  'SHUTTING_DOWN',
  'TIMEOUT_NOT_APPLIED',
  'INTERNAL',
]);

export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'QUEUE_FULL',
  'SHUTTING_DOWN',
  'TIMEOUT_NOT_APPLIED',
]);
