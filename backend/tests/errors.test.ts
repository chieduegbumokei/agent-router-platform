import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  contentBlocked,
  invalidCredentials,
  notFound,
  providerQuotaExceeded,
  rateLimited,
  redact,
  toHttpError,
  toSseError,
  validationFailed,
} from '../src/core/errors';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('error constructors', () => {
  it('invalidCredentials → 401 with a generic message that never leaks which field was wrong', () => {
    const err = invalidCredentials();
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(err.message).toBe('Invalid email or password');
  });

  it('validationFailed → 400 carrying the supplied message', () => {
    const err = validationFailed('email is required');
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toBe('email is required');
  });

  it('notFound → 404, defaulting the subject to "Resource"', () => {
    expect(notFound().message).toBe('Resource not found');
    expect(notFound('Conversation').message).toBe('Conversation not found');
    expect(notFound('Conversation').status).toBe(404);
  });

  it('contentBlocked → 400 naming the blocked topic', () => {
    const err = contentBlocked('weapons');
    expect(err.status).toBe(400);
    expect(err.code).toBe('CONTENT_BLOCKED');
    expect(err.message).toContain('weapons');
  });

  it('rateLimited → 429', () => {
    const err = rateLimited();
    expect(err.status).toBe(429);
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('providerQuotaExceeded → 402 telling the user to recharge tokens', () => {
    const err = providerQuotaExceeded();
    expect(err.status).toBe(402);
    expect(err.code).toBe('PROVIDER_QUOTA_EXCEEDED');
    expect(err.message).toContain('recharge');
  });
});

describe('toHttpError', () => {
  it('preserves an AppError\'s status, code, and message verbatim', () => {
    const { status, body } = toHttpError(notFound('Project'));
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Project not found');
  });

  it('maps an unknown throw to a generic 500 and does not leak its message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status, body } = toHttpError(new Error('DB password is hunter2'));
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(spy).toHaveBeenCalled(); // internal detail goes to the log, not the wire
  });

  it('handles non-Error throws (e.g. a bare string) without crashing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { status, body } = toHttpError('boom');
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL');
  });
});

describe('toSseError', () => {
  it('passes an AppError through as an in-band code + message', () => {
    expect(toSseError(rateLimited())).toEqual({
      code: 'RATE_LIMITED',
      message: 'Too many requests, slow down',
    });
  });

  it('passes providerQuotaExceeded through so the chat UI can show "recharge tokens" verbatim', () => {
    expect(toSseError(providerQuotaExceeded())).toEqual({
      code: 'PROVIDER_QUOTA_EXCEEDED',
      message: 'The AI provider account is out of tokens. Please recharge the account balance and try again.',
    });
  });

  it('collapses an unknown throw to AGENT_STREAM_FAILED with a safe message', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = toSseError(new Error('bedrock exploded'));
    expect(out.code).toBe('AGENT_STREAM_FAILED');
    expect(out.message).toBe('The agent failed while responding');
    expect(out.message).not.toContain('bedrock');
  });
});

describe('redact', () => {
  it('masks sensitive keys case-insensitively while keeping the rest', () => {
    const out = redact({
      email: 'a@b.com',
      password: 'secret123',
      refreshToken: 'rt-abc',
      Authorization: 'Bearer xyz',
      passwordHash: '$2a$...',
      secret: 'shh',
    });
    expect(out.email).toBe('a@b.com');
    expect(out.password).toBe('[REDACTED]');
    expect(out.refreshToken).toBe('[REDACTED]');
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.passwordHash).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
  });

  it('leaves non-sensitive objects untouched', () => {
    expect(redact({ userId: 'u1', count: 3 })).toEqual({ userId: 'u1', count: 3 });
  });

  it('is shallow: nested secrets are not redacted (documented limitation)', () => {
    const out = redact({ nested: { password: 'still-here' } });
    expect(out.nested).toEqual({ password: 'still-here' });
  });
});
