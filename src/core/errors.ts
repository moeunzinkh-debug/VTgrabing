/** Application error carrying a stable machine readable code + HTTP status. */

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'not_found'
  | 'unauthorized'
  | 'not_configured'
  | 'unsupported_source'
  | 'conflict'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  not_found: 404,
  unauthorized: 401,
  not_configured: 503,
  unsupported_source: 422,
  conflict: 409,
  internal_error: 500,
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError('bad_request', message, details);
export const validationFailed = (message: string, details?: unknown) =>
  new AppError('validation_failed', message, details);
export const notFound = (message: string) => new AppError('not_found', message);
export const unauthorized = (message: string) => new AppError('unauthorized', message);
export const notConfigured = (message: string, details?: unknown) =>
  new AppError('not_configured', message, details);
export const unsupportedSource = (message: string, details?: unknown) =>
  new AppError('unsupported_source', message, details);
export const conflict = (message: string) => new AppError('conflict', message);
export const internalError = (message: string, details?: unknown) =>
  new AppError('internal_error', message, details);

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new AppError('internal_error', error.message);
  return new AppError('internal_error', 'Unexpected error', error);
}
