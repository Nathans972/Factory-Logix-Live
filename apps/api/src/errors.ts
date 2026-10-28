/** Errors with the wire shape defined in docs/API.md: `{error, message, statusCode}` (+ `issues` for zod). */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown): ApiError =>
  new ApiError(400, 'bad_request', message, details);
export const unauthorized = (message = 'authentication required'): ApiError =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'insufficient role'): ApiError => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'not found'): ApiError => new ApiError(404, 'not_found', message);
export const conflict = (message: string): ApiError => new ApiError(409, 'conflict', message);
export const tooManyRequests = (message: string): ApiError => new ApiError(429, 'too_many_requests', message);
export const unavailable = (message = 'service unavailable'): ApiError =>
  new ApiError(503, 'unavailable', message);
