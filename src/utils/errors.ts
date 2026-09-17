/**
 * Every error the API returns deliberately carries a stable machine code, so
 * clients branch on `error.code` and never on message text.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (code = 'UNAUTHORIZED', message = 'Authentication required') =>
  new AppError(401, code, message);

export const forbidden = (code = 'FORBIDDEN', message = 'You do not have access to this resource') =>
  new AppError(403, code, message);

export const notFound = (code = 'NOT_FOUND', message = 'Resource not found') =>
  new AppError(404, code, message);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);

export const tooManyRequests = (code: string, message: string, details?: unknown) =>
  new AppError(429, code, message, details);

export const internal = (message = 'Something went wrong') =>
  new AppError(500, 'INTERNAL_ERROR', message);
