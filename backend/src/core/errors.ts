export type ErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_REFRESH_REUSED'
  | 'VALIDATION_FAILED'
  | 'CONTENT_BLOCKED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'AGENT_STREAM_FAILED'
  | 'STORAGE_UNAVAILABLE'
  | 'INTERNAL';

/**
 * Typed application error. `message` must always be safe to show a client;
 * internal detail goes to the logger, never over the wire.
 */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const invalidCredentials = () =>
  new AppError('AUTH_INVALID_CREDENTIALS', 401, 'Invalid email or password');
export const validationFailed = (message: string) =>
  new AppError('VALIDATION_FAILED', 400, message);
export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', 404, `${what} not found`);
export const contentBlocked = (topic: string) =>
  new AppError('CONTENT_BLOCKED', 400, `This assistant can't help with "${topic}" - the topic is blocked by policy.`);
export const rateLimited = () =>
  new AppError('RATE_LIMITED', 429, 'Too many requests, slow down');
export const providerQuotaExceeded = () =>
  new AppError(
    'PROVIDER_QUOTA_EXCEEDED',
    402,
    'The AI provider account is out of tokens. Please recharge the account balance and try again.',
  );

/** Boundary translation: any thrown value → HTTP status + safe JSON body. */
export function toHttpError(err: unknown): { status: number; body: { error: { code: ErrorCode; message: string } } } {
  if (err instanceof AppError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  logError(err);
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Internal server error' } } };
}

/** Boundary translation for mid-stream failures → in-band SSE error event. */
export function toSseError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  logError(err);
  return { code: 'AGENT_STREAM_FAILED', message: 'The agent failed while responding' };
}

const REDACT_KEYS = new Set(['password', 'refreshtoken', 'authorization', 'passwordhash', 'secret']);

/** Shallow redaction for structured logging. */
export function redact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

export function logError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[error]', err instanceof Error ? `${err.name}: ${err.message}` : err);
}
