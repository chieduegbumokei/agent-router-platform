import { z } from 'zod';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/passwords';
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from '../auth/tokens';
import { config } from '../core/config';
import { invalidCredentials, rateLimited, validationFailed } from '../core/errors';
import { newId } from '../core/ids';
import { RateLimiter } from '../core/rate-limit';
import { getStore } from '../store/index';
import { json, type ApiRequest, type ApiResponse } from './http';

const credentialsSchema = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(128),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1).max(2048) });

/** Per-IP brute-force limiter across all auth endpoints. */
const authLimiter = new RateLimiter(config.authRatePerMin, config.authRatePerMin);

function checkAuthRate(req: ApiRequest): void {
  if (!authLimiter.take(`auth:${req.ip}`)) throw rateLimited();
}

const publicUser = (userId: string, email: string) => ({ userId, email });

export async function signup(req: ApiRequest): Promise<ApiResponse> {
  checkAuthRate(req);
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    throw validationFailed('email must be valid and password at least 8 characters');
  }
  const { email, password } = parsed.data;

  const userId = newId();
  await getStore().createUser({
    userId,
    email,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  });

  return json(201, {
    user: publicUser(userId, email),
    accessToken: signAccessToken({ sub: userId, email }),
    refreshToken: await issueRefreshToken(userId),
  });
}

export async function login(req: ApiRequest): Promise<ApiResponse> {
  checkAuthRate(req);
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) throw invalidCredentials(); // same error as a bad password
  const { email, password } = parsed.data;

  const user = await getStore().getUserByEmail(email);
  if (!user) {
    // Unknown email: burn the same bcrypt work as a real check so response
    // timing doesn't reveal whether the account exists.
    await verifyPassword(password, DUMMY_HASH);
    throw invalidCredentials();
  }
  if (!(await verifyPassword(password, user.passwordHash))) throw invalidCredentials();

  return json(200, {
    user: publicUser(user.userId, user.email),
    accessToken: signAccessToken({ sub: user.userId, email: user.email }),
    refreshToken: await issueRefreshToken(user.userId),
  });
}

export async function logout(req: ApiRequest): Promise<ApiResponse> {
  checkAuthRate(req);
  const parsed = refreshSchema.safeParse(req.body);
  // Always succeed: logout is idempotent and must not leak token validity.
  if (parsed.success) await revokeRefreshToken(parsed.data.refreshToken);
  return json(200, { ok: true });
}

export async function refresh(req: ApiRequest): Promise<ApiResponse> {
  checkAuthRate(req);
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) throw validationFailed('refreshToken is required');

  const { userId, refreshToken } = await rotateRefreshToken(parsed.data.refreshToken);
  const user = await getStore().getUserById(userId);
  if (!user) throw invalidCredentials();

  return json(200, {
    accessToken: signAccessToken({ sub: user.userId, email: user.email }),
    refreshToken,
  });
}
