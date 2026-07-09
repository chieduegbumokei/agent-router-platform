import { beforeEach, describe, expect, it } from 'vitest';
import {
  issueRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '../src/auth/tokens';
import { AppError } from '../src/core/errors';
import { createMemoryStore } from '../src/store/memory';
import { setStore } from '../src/store/index';

beforeEach(() => setStore(createMemoryStore()));

describe('access tokens', () => {
  it('signs and verifies claims', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@b.com' });
    const claims = verifyAccessToken(token);
    expect(claims).toEqual({ sub: 'user-1', email: 'a@b.com' });
  });

  it('rejects an expired token with AUTH_TOKEN_EXPIRED', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@b.com' }, -10);
    try {
      verifyAccessToken(token);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('AUTH_TOKEN_EXPIRED');
    }
  });

  it('rejects a tampered token with AUTH_TOKEN_INVALID', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@b.com' });
    try {
      verifyAccessToken(token.slice(0, -4) + 'AAAA');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('AUTH_TOKEN_INVALID');
    }
  });
});

describe('refresh token rotation', () => {
  it('rotates a valid token and returns a new one', async () => {
    const t1 = await issueRefreshToken('user-1');
    const { userId, refreshToken: t2 } = await rotateRefreshToken(t1);
    expect(userId).toBe('user-1');
    expect(t2).not.toBe(t1);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const t1 = await issueRefreshToken('user-1');
    const { refreshToken: t2 } = await rotateRefreshToken(t1);

    // replaying the already-rotated t1 = theft signal
    await expect(rotateRefreshToken(t1)).rejects.toMatchObject({ code: 'AUTH_REFRESH_REUSED' });
    // the legitimate successor t2 is now dead too (family revoked)
    await expect(rotateRefreshToken(t2)).rejects.toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
  });

  it('rejects garbage tokens', async () => {
    await expect(rotateRefreshToken('not-a-token')).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });
});
