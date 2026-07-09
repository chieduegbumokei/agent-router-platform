import { beforeEach, describe, expect, it } from 'vitest';
import { login, logout, refresh, signup } from '../src/handlers/auth';
import type { ApiRequest } from '../src/handlers/http';
import { createMemoryStore } from '../src/store/memory';
import { setStore } from '../src/store/index';

let ipCounter = 0;
/** Unique IP per request so the per-IP auth rate limiter never interferes across tests. */
const makeReq = (body: unknown, ip?: string): ApiRequest => ({
  method: 'POST',
  path: '/auth',
  params: {},
  query: {},
  headers: {},
  body,
  ip: ip ?? `10.0.0.${++ipCounter}`,
});

beforeEach(() => setStore(createMemoryStore()));

describe('signup', () => {
  it('creates a user and returns both tokens', async () => {
    const res = await signup(makeReq({ email: 'A@Example.com', password: 'password123' }));
    expect(res.status).toBe(201);
    const body = res.body as { user: { email: string }; accessToken: string; refreshToken: string };
    expect(body.user.email).toBe('a@example.com'); // normalized
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it('rejects duplicate emails with CONFLICT', async () => {
    await signup(makeReq({ email: 'a@b.com', password: 'password123' }));
    await expect(signup(makeReq({ email: 'a@b.com', password: 'password123' }))).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
  });

  it('rejects weak passwords', async () => {
    await expect(signup(makeReq({ email: 'a@b.com', password: 'short' }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('login', () => {
  it('authenticates valid credentials', async () => {
    await signup(makeReq({ email: 'a@b.com', password: 'password123' }));
    const res = await login(makeReq({ email: 'a@b.com', password: 'password123' }));
    expect(res.status).toBe(200);
  });

  it('returns the SAME error for wrong password and unknown email (no enumeration)', async () => {
    await signup(makeReq({ email: 'a@b.com', password: 'password123' }));
    const wrongPw = login(makeReq({ email: 'a@b.com', password: 'wrong-password' }));
    const noUser = login(makeReq({ email: 'ghost@b.com', password: 'password123' }));
    await expect(wrongPw).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    await expect(noUser).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });
});

describe('refresh', () => {
  it('rotates and keeps the session alive', async () => {
    const s = await signup(makeReq({ email: 'a@b.com', password: 'password123' }));
    const { refreshToken } = s.body as { refreshToken: string };
    const r = await refresh(makeReq({ refreshToken }));
    expect(r.status).toBe(200);
    const rBody = r.body as { accessToken: string; refreshToken: string };
    expect(rBody.refreshToken).not.toBe(refreshToken);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const s = await signup(makeReq({ email: 'a@b.com', password: 'password123' }));
    const { refreshToken: original } = s.body as { refreshToken: string };
    const r = await refresh(makeReq({ refreshToken: original }));
    const { refreshToken: rotated } = r.body as { refreshToken: string };

    // Replaying the consumed token is treated as theft...
    await expect(refresh(makeReq({ refreshToken: original }))).rejects.toMatchObject({
      code: 'AUTH_REFRESH_REUSED',
    });
    // ...which kills the legitimate descendant too.
    await expect(refresh(makeReq({ refreshToken: rotated }))).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });

  it('lets exactly one of two concurrent rotations win, then revokes the family', async () => {
    const s = await signup(makeReq({ email: 'a@b.com', password: 'password123' }));
    const { refreshToken } = s.body as { refreshToken: string };

    // Both requests read the token before either marks it rotated - the
    // conditional markRotated must catch the race that the read misses.
    const results = await Promise.allSettled([
      refresh(makeReq({ refreshToken })),
      refresh(makeReq({ refreshToken })),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'AUTH_REFRESH_REUSED',
    });

    // The "winner's" token is in the revoked family, so it is dead as well.
    const won = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      body: unknown;
    }>;
    const { refreshToken: winner } = won.value.body as { refreshToken: string };
    await expect(refresh(makeReq({ refreshToken: winner }))).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });
});

describe('logout', () => {
  it('revokes the refresh-token family server-side', async () => {
    const s = await signup(makeReq({ email: 'a@b.com', password: 'password123' }));
    const { refreshToken } = s.body as { refreshToken: string };

    const out = await logout(makeReq({ refreshToken }));
    expect(out.status).toBe(200);
    await expect(refresh(makeReq({ refreshToken }))).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });

  it('succeeds quietly on garbage tokens (idempotent, no validity oracle)', async () => {
    const out = await logout(makeReq({ refreshToken: 'not-a-real-token' }));
    expect(out.status).toBe(200);
  });
});

describe('auth rate limiting', () => {
  it('blocks a single IP after 5 attempts', async () => {
    const attack = 'attacker-ip';
    for (let i = 0; i < 5; i++) {
      await login(makeReq({ email: 'a@b.com', password: 'password123' }, attack)).catch(() => {});
    }
    await expect(
      login(makeReq({ email: 'a@b.com', password: 'password123' }, attack)),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
