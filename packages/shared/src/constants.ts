export const BASE_MAX = 1_000_000;
export const MAX_ID = Number.MAX_SAFE_INTEGER;
export const PAGE_LIMIT_MAX = 20;
export const FILTER_MAX_LEN = 16;
export const FILTER_PATTERN = /^\d{1,16}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

export const CLIENT_TIMEOUT_MAIN_MS = 20_000;
export const CLIENT_TIMEOUT_ADD_MS = 40_000;
export const CLIENT_CHANGE_BUFFER = 1_000;
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_DEAD_AFTER_MS = 40_000;
export const CHANGES_PAGE_MAX = 1_000;
