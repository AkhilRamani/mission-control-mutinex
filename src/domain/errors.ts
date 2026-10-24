export class AppError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    public readonly code: string,
    message: string,
    public readonly recovery: string,
    public readonly retryAfter?: number,
  ) { super(message); }
}

export function unauthenticated(): AppError {
  return new AppError(401, 'UNAUTHENTICATED', 'Authentication required.', 'Run mc login.');
}

export function notFound(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Resource not found.', 'List visible resources and check the IDs.');
}

export function forbidden(): AppError {
  return new AppError(403, 'FORBIDDEN', 'This action is not permitted.', 'Use an account with permission for this action.');
}
