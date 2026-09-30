import {
  CLIENT_TIMEOUT_ADD_MS,
  CLIENT_TIMEOUT_MAIN_MS,
  IDEMPOTENCY_HEADER,
  NOT_APPLIED_CODES,
  RETRYABLE_CODES,
  type AddItemResponse,
  type ApiErrorBody,
  type ChangesResponse,
  type DeselectResponse,
  type ErrorCode,
  type ItemsPage,
  type ReorderBody,
  type ReorderResponse,
  type SelectResponse,
  type SelectedPage,
} from '@mim/shared';

export type ClientErrorCode = 'NETWORK' | 'TIMEOUT' | 'BAD_RESPONSE' | 'ABORTED';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | ClientErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get aborted(): boolean {
    return this.code === 'ABORTED';
  }
}

export type FailureKind = 'not_applied' | 'unknown' | 'fatal' | 'rejected';

export function failureKind(error: ApiError): FailureKind {
  if (error.code === 'OUTCOME_UNKNOWN') return 'fatal';
  if (error.code === 'NETWORK' || error.code === 'TIMEOUT' || error.code === 'BAD_RESPONSE') {
    return 'unknown';
  }
  if (NOT_APPLIED_CODES.has(error.code as ErrorCode)) return 'not_applied';
  return 'rejected';
}

export function isRetryable(error: ApiError): boolean {
  return (
    error.code === 'NETWORK' ||
    error.code === 'TIMEOUT' ||
    RETRYABLE_CODES.has(error.code as ErrorCode)
  );
}

export interface RetryPolicy {
  delays: readonly number[];
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { delays: [500, 1000, 2000], maxDelayMs: 10_000 };

export interface ApiOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  retry?: RetryPolicy;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (error: ApiError, attempt: number) => void;
}

export interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError(0, 'ABORTED', 'Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ApiError(0, 'ABORTED', 'Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfter(header: string | null, details: Record<string, unknown>): number | null {
  if (typeof details.retryAfterMs === 'number') return details.retryAfterMs;
  if (header && /^\d+$/.test(header)) return Number(header) * 1000;
  return null;
}

export class Api {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: ApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.retryPolicy = options.retry ?? DEFAULT_RETRY;
    this.sleep = options.sleep ?? abortableSleep;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs ?? CLIENT_TIMEOUT_MAIN_MS);
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) controller.abort();

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;

    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.baseUrl + path, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch {
        throw this.transportError(timedOut, opts.signal);
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw this.transportError(timedOut, opts.signal);
      }
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new ApiError(res.status, 'BAD_RESPONSE', `Unreadable response (${res.status})`);
        }
      }
      if (res.ok) return json as T;
      const body = json as Partial<ApiErrorBody> | null;
      const error = body?.error;
      if (!error?.code) {
        const code: ErrorCode | ClientErrorCode =
          res.status === 429
            ? 'RATE_LIMITED'
            : res.status === 503
              ? 'QUEUE_FULL'
              : res.status === 504
                ? 'TIMEOUT_NOT_APPLIED'
                : 'BAD_RESPONSE';
        throw new ApiError(
          res.status,
          code,
          `HTTP ${res.status}`,
          {},
          parseRetryAfter(res.headers.get('Retry-After'), {}),
        );
      }
      const details = error.details ?? {};
      throw new ApiError(
        res.status,
        error.code,
        error.message ?? error.code,
        details,
        parseRetryAfter(res.headers.get('Retry-After'), details),
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  async withRetry<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
    policy = this.retryPolicy,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request<T>(method, path, opts);
      } catch (e) {
        const error = e as ApiError;
        if (error.aborted || !isRetryable(error) || attempt >= policy.delays.length) throw error;
        const delay = Math.min(
          policy.maxDelayMs,
          Math.max(policy.delays[attempt]!, error.retryAfterMs ?? 0),
        );
        this.options.onRetry?.(error, attempt + 1);
        await this.sleep(delay, opts.signal);
      }
    }
  }

  getItems(filter: string, cursor: string | null, limit: number, signal?: AbortSignal) {
    return this.withRetry<ItemsPage>('GET', `/api/items?${pageQuery(filter, cursor, limit)}`, {
      signal,
    });
  }

  getSelected(filter: string, cursor: string | null, limit: number, signal?: AbortSignal) {
    return this.withRetry<SelectedPage>(
      'GET',
      `/api/selected?${pageQuery(filter, cursor, limit)}`,
      { signal },
    );
  }

  getChanges(since: number, instance: string | null, signal?: AbortSignal) {
    const q = instance !== null ? `&instance=${encodeURIComponent(instance)}` : '';
    return this.withRetry<ChangesResponse>('GET', `/api/changes?since=${since}${q}`, { signal });
  }

  addItem(id: number, key: string) {
    return this.withRetry<AddItemResponse>('POST', '/api/items', {
      body: { id },
      idempotencyKey: key,
      timeoutMs: CLIENT_TIMEOUT_ADD_MS,
    });
  }

  select(id: number, key: string) {
    return this.withRetry<SelectResponse>('POST', '/api/selected', {
      body: { id },
      idempotencyKey: key,
    });
  }

  deselect(id: number, key: string) {
    return this.withRetry<DeselectResponse>('DELETE', `/api/selected/${id}`, {
      idempotencyKey: key,
    });
  }

  reorder(body: ReorderBody, key: string) {
    return this.withRetry<ReorderResponse>('PATCH', '/api/selected/order', {
      body,
      idempotencyKey: key,
    });
  }

  private transportError(timedOut: boolean, signal?: AbortSignal): ApiError {
    if (timedOut) return new ApiError(0, 'TIMEOUT', 'The server did not answer in time');
    if (signal?.aborted) return new ApiError(0, 'ABORTED', 'Aborted');
    return new ApiError(0, 'NETWORK', 'Network error');
  }
}

function pageQuery(filter: string, cursor: string | null, limit: number): string {
  const q = new URLSearchParams();
  if (filter) q.set('filter', filter);
  if (cursor) q.set('cursor', cursor);
  q.set('limit', String(limit));
  return q.toString();
}
