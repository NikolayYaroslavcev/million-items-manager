import { ERROR_STATUS, type ApiErrorBody, type ErrorCode } from '@mim/shared';

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_STATUS[code];
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export interface OpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function errorResult(error: AppError): OpResult {
  return {
    status: error.status,
    body: error.toBody(),
    ...(error.headers ? { headers: error.headers } : {}),
  };
}

export function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  headers?: Record<string, string>,
): OpResult {
  return errorResult(new AppError(code, message, details, headers));
}

export function resultCode(result: OpResult): ErrorCode | null {
  const body = result.body as Partial<ApiErrorBody> | null;
  return body?.error?.code ?? null;
}
