import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiFetch,
  clearSession,
  decodeUser,
  getAccessToken,
  login,
  logoutSession,
  refreshSession,
} from '../src/lib/api';

const fakeJwt = (sub: string, email: string) =>
  `header.${btoa(JSON.stringify({ sub, email }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}.sig`;

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  clearSession();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('decodeUser', () => {
  it('extracts userId and email from a JWT payload', () => {
    expect(decodeUser(fakeJwt('u1', 'a@b.com'))).toEqual({ userId: 'u1', email: 'a@b.com' });
  });
});

describe('login', () => {
  it('stores the refresh token and keeps the access token in memory only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ accessToken: fakeJwt('u1', 'a@b.com'), refreshToken: 'refresh-1' })),
    );
    const user = await login('a@b.com', 'password123');
    expect(user.email).toBe('a@b.com');
    expect(getAccessToken()).toContain('header.');
    expect(localStorage.getItem('assistant.refreshToken')).toBe('refresh-1');
    // access token must NOT be persisted anywhere
    expect(Object.keys(localStorage).some((k) => localStorage.getItem(k)?.includes('header.'))).toBe(false);
  });

  it('throws ApiError with the backend error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password' } }, 401)),
    );
    await expect(login('a@b.com', 'wrong')).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
      status: 401,
    });
  });
});

describe('refreshSession', () => {
  it('returns null when no refresh token is stored', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await refreshSession()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears the session when the refresh is rejected (e.g. reuse-revoked family)', async () => {
    localStorage.setItem('assistant.refreshToken', 'stolen-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ error: { code: 'AUTH_REFRESH_REUSED', message: 'reuse' } }, 401)),
    );
    expect(await refreshSession()).toBeNull();
    expect(localStorage.getItem('assistant.refreshToken')).toBeNull();
  });

  it('keeps the stored token on transient (non-401) failures', async () => {
    localStorage.setItem('assistant.refreshToken', 'refresh-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ error: { code: 'INTERNAL', message: 'boom' } }, 500)),
    );
    expect(await refreshSession()).toBeNull();
    expect(localStorage.getItem('assistant.refreshToken')).toBe('refresh-1');
  });

  it('single-flights concurrent callers (refresh tokens are single-use)', async () => {
    localStorage.setItem('assistant.refreshToken', 'refresh-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ accessToken: fakeJwt('u1', 'a@b.com'), refreshToken: 'refresh-2' })),
    );
    const [a, b, c] = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(fetch).toHaveBeenCalledTimes(1); // one POST shared by all three
    expect(a?.userId).toBe('u1');
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(localStorage.getItem('assistant.refreshToken')).toBe('refresh-2');
  });

  it('refreshes again on the next call after the in-flight one settles', async () => {
    localStorage.setItem('assistant.refreshToken', 'refresh-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ accessToken: fakeJwt('u1', 'a@b.com'), refreshToken: 'refresh-2' })),
    );
    await refreshSession();
    await refreshSession();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('logoutSession', () => {
  it('clears the session locally and revokes the token server-side', async () => {
    localStorage.setItem('assistant.refreshToken', 'refresh-1');
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        bodies.push([url, JSON.parse(init?.body as string)]);
        return ok({ ok: true });
      }),
    );
    logoutSession();
    expect(localStorage.getItem('assistant.refreshToken')).toBeNull();
    expect(bodies).toEqual([[expect.stringContaining('/auth/logout'), { refreshToken: 'refresh-1' }]]);
  });

  it('does nothing over the network when no session is stored', () => {
    vi.stubGlobal('fetch', vi.fn());
    logoutSession();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('apiFetch 401 → silent refresh → retry', () => {
  it('retries exactly once after refreshing', async () => {
    localStorage.setItem('assistant.refreshToken', 'refresh-1');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(url as string);
        if ((url as string).endsWith('/auth/refresh')) {
          return ok({ accessToken: fakeJwt('u1', 'a@b.com'), refreshToken: 'refresh-2' });
        }
        // first data call → 401 (expired), second → 200
        const isRetry = (init?.headers as Record<string, string>).authorization.includes('header.');
        return isRetry
          ? ok({ conversations: [] })
          : ok({ error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } }, 401);
      }),
    );

    const data = await apiFetch<{ conversations: unknown[] }>('/conversations');
    expect(data.conversations).toEqual([]);
    expect(calls.filter((u) => u.endsWith('/conversations'))).toHaveLength(2);
    expect(calls.filter((u) => u.endsWith('/auth/refresh'))).toHaveLength(1);
    expect(localStorage.getItem('assistant.refreshToken')).toBe('refresh-2'); // rotated
  });

  it('gives up with 401 when the refresh itself fails', async () => {
    localStorage.setItem('assistant.refreshToken', 'dead-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        (url as string).endsWith('/auth/refresh')
          ? ok({ error: { code: 'AUTH_TOKEN_INVALID', message: 'invalid' } }, 401)
          : ok({ error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } }, 401),
      ),
    );
    await expect(apiFetch('/conversations')).rejects.toBeInstanceOf(ApiError);
  });
});
