import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../core/config';
import { AppError } from '../core/errors';
import { newId, newSecret } from '../core/ids';
import { getStore } from '../store/index';

export interface AccessClaims {
  sub: string; // userId
  email: string;
}

export function signAccessToken(
  claims: AccessClaims,
  ttlSec: number = config.accessTokenTtlSec,
): string {
  return jwt.sign({ sub: claims.sub, email: claims.email }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: ttlSec,
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload.sub || typeof payload.email !== 'string') {
      throw new AppError('AUTH_TOKEN_INVALID', 401, 'Invalid token');
    }
    return { sub: payload.sub, email: payload.email };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError('AUTH_TOKEN_EXPIRED', 401, 'Token expired');
    }
    throw new AppError('AUTH_TOKEN_INVALID', 401, 'Invalid token');
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens - opaque, rotated, reuse-detected.
// Wire format: base64url("<userId>.<tokenId>.<secret>") so lookup is a direct
// Get; only sha256(secret) is stored.
// ---------------------------------------------------------------------------

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const invalidRefresh = () => new AppError('AUTH_TOKEN_INVALID', 401, 'Invalid refresh token');

const refreshReused = () => new AppError('AUTH_REFRESH_REUSED', 401, 'Refresh token reuse detected');

function parseRefreshToken(token: string): { userId: string; tokenId: string; secret: string } {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const [userId, tokenId, secret] = decoded.split('.') as [string, string, string];
    if (!userId || !tokenId || !secret) throw new Error('malformed');
    return { userId, tokenId, secret };
  } catch {
    throw invalidRefresh();
  }
}

export async function issueRefreshToken(userId: string, familyId?: string): Promise<string> {
  const tokenId = newId();
  const secret = newSecret();
  await getStore().putRefreshToken({
    userId,
    tokenId,
    familyId: familyId ?? tokenId,
    secretHash: sha256(secret),
    expiresAt: Math.floor(Date.now() / 1000) + config.refreshTokenTtlSec,
  });
  return Buffer.from(`${userId}.${tokenId}.${secret}`).toString('base64url');
}

export async function rotateRefreshToken(
  token: string,
): Promise<{ userId: string; refreshToken: string }> {
  const { userId, tokenId, secret } = parseRefreshToken(token);

  const store = getStore();
  const rec = await store.getRefreshToken(userId, tokenId);
  if (!rec || rec.revoked || rec.secretHash !== sha256(secret)) throw invalidRefresh();
  if (rec.expiresAt < Math.floor(Date.now() / 1000)) throw invalidRefresh();

  if (rec.rotatedTo) {
    // Reuse of an already-rotated token → assume theft, kill the whole family.
    await store.revokeFamily(userId, rec.familyId);
    throw refreshReused();
  }

  const newToken = await issueRefreshToken(userId, rec.familyId);
  const newTokenId = Buffer.from(newToken, 'base64url').toString('utf8').split('.')[1]!;
  if (!(await store.markRotated(userId, tokenId, newTokenId))) {
    // Lost a concurrent rotation race: someone else consumed this token between
    // our read and write. Same treatment as reuse - revoke the family (which
    // includes the token issued above, so nothing live leaks from this branch).
    await store.revokeFamily(userId, rec.familyId);
    throw refreshReused();
  }
  return { userId, refreshToken: newToken };
}

/**
 * Logout: revoke the token's whole family. Best-effort and quiet on invalid
 * input - logout is idempotent and must not leak whether a token was live.
 */
export async function revokeRefreshToken(token: string): Promise<void> {
  let parsed: ReturnType<typeof parseRefreshToken>;
  try {
    parsed = parseRefreshToken(token);
  } catch {
    return;
  }
  const store = getStore();
  const rec = await store.getRefreshToken(parsed.userId, parsed.tokenId);
  if (!rec || rec.secretHash !== sha256(parsed.secret)) return;
  await store.revokeFamily(parsed.userId, rec.familyId);
}
