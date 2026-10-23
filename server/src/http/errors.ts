export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (code = 'unauthorized', message = 'Authentication required') =>
  new HttpError(401, code, message);
export const forbidden = (code = 'forbidden', message = 'Forbidden') => new HttpError(403, code, message);
export const notFound = (code = 'not_found', message = 'Not found') => new HttpError(404, code, message);
export const conflict = (code = 'conflict', message = 'Conflict') => new HttpError(409, code, message);
export const tooMany = (code = 'rate_limited', message = 'Too many requests') => new HttpError(429, code, message);
export const upstream = (code = 'upstream_error', message = 'Upstream error') => new HttpError(502, code, message);

export function errorBody(err: HttpError | { code?: string; message?: string }) {
  const status = err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : (err as any)?.code ?? 'internal_error';
  const message =
    err instanceof HttpError
      ? err.message
      : status >= 500
        ? 'Internal server error'
        : ((err as any)?.message ?? 'Request failed');
  return { error: { code, message, ...(err instanceof HttpError && err.details !== undefined ? { details: err.details } : {}) } };
}
