import type { SessionUser } from './types';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
/** Deployed, the streaming endpoint may live on a separate Lambda Function URL. */
export const CHAT_URL = process.env.NEXT_PUBLIC_CHAT_URL ?? API_URL;

const REFRESH_KEY = 'assistant.refreshToken';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// Access token lives in memory only (never persisted); the refresh token is the
// only credential in localStorage - trade-off documented in docs/LLD.md §7.
let accessToken: string | null = null;

export const getAccessToken = () => accessToken;

function setSession(access: string, refresh: string): SessionUser {
  accessToken = access;
  localStorage.setItem(REFRESH_KEY, refresh);
  return decodeUser(access);
}

export function clearSession(): void {
  accessToken = null;
  localStorage.removeItem(REFRESH_KEY);
}

/**
 * Logout: clear locally, then revoke the refresh-token family server-side.
 * Fire-and-forget - signing out must work offline too.
 */
export function logoutSession(): void {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  clearSession();
  if (refreshToken) void post('/auth/logout', { refreshToken }).catch(() => {});
}

/** Decode the JWT payload for display claims (verification happens server-side). */
export function decodeUser(token: string): SessionUser {
  const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
  return { userId: payload.sub, email: payload.email };
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function toApiError(res: Response): Promise<ApiError> {
  const data = await res.json().catch(() => null);
  const err = (data as { error?: { code: string; message: string } } | null)?.error;
  return new ApiError(res.status, err?.code ?? 'INTERNAL', err?.message ?? 'Request failed');
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const res = await post('/auth/login', { email, password });
  if (!res.ok) throw await toApiError(res);
  const data = await res.json();
  return setSession(data.accessToken, data.refreshToken);
}

export async function signup(email: string, password: string): Promise<SessionUser> {
  const res = await post('/auth/signup', { email, password });
  if (!res.ok) throw await toApiError(res);
  const data = await res.json();
  return setSession(data.accessToken, data.refreshToken);
}

/**
 * Silent session restore/refresh. Returns null when there is no valid session.
 * Single-flight: refresh tokens are single-use (rotation + family-wide reuse
 * detection), so concurrent callers - parallel 401 retries, multiple tabs
 * mounting, StrictMode double-effects - must share one request. A second
 * concurrent POST with the same token would trip the server's theft detector
 * and revoke the whole session.
 */
let refreshInFlight: Promise<SessionUser | null> | null = null;

export function refreshSession(): Promise<SessionUser | null> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(): Promise<SessionUser | null> {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return null;
  const res = await post('/auth/refresh', { refreshToken });
  if (!res.ok) {
    // Only a 401 means the token is dead; keep it through transient
    // server errors and rate limits so a retry/reload can still recover.
    if (res.status === 401) clearSession();
    return null;
  }
  const data = await res.json();
  return setSession(data.accessToken, data.refreshToken);
}

/**
 * Authenticated fetch with exactly one silent-refresh retry on 401.
 * Throws ApiError on failure.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const attempt = () =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${accessToken}`,
      },
    });

  let res = await attempt();
  if (res.status === 401) {
    const user = await refreshSession();
    if (!user) throw new ApiError(401, 'AUTH_TOKEN_EXPIRED', 'Session expired');
    res = await attempt();
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}
