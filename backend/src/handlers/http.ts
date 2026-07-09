import { AppError } from '../core/errors';
import type { StreamEvent } from '../core/types';
import { verifyAccessToken, type AccessClaims } from '../auth/tokens';

/**
 * Transport-neutral request/response. Both the Express adapter (local) and the
 * Lambda wrappers (deployed) normalize into these shapes, so handlers are
 * written once and tested without any HTTP server.
 */
export interface ApiRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
  ip: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export const json = (status: number, body: unknown): ApiResponse => ({ status, body });

/** SSE sink implemented by each transport (Express res / Lambda responseStream). */
export interface SseWriter {
  write(event: StreamEvent): void;
  close(): void;
  /** Fires when the client disconnects - aborts LLM/tool work downstream. */
  signal: AbortSignal;
}

export function requireAuth(req: ApiRequest): AccessClaims {
  const header = req.headers['authorization'] ?? req.headers['Authorization'];
  if (!header?.startsWith('Bearer ')) {
    throw new AppError('AUTH_TOKEN_INVALID', 401, 'Missing bearer token');
  }
  return verifyAccessToken(header.slice('Bearer '.length));
}
