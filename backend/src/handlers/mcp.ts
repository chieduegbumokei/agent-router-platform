import { z } from 'zod';
import { newId } from '../core/ids';
import { notFound, validationFailed } from '../core/errors';
import { config } from '../core/config';
import { assertAllowedMcpUrl, probeMcpServer } from '../mcp/client';
import { getStore } from '../store/index';
import type { McpServerRecord } from '../store/types';
import { json, requireAuth, type ApiRequest, type ApiResponse } from './http';

/**
 * User-connected MCP servers (Settings → Connectors). The auth token is write-
 * only: stored server-side, never echoed back (`hasAuth` says one exists).
 */

const createSchema = z.object({
  name: z.string().min(1).max(40).regex(/^[\w .-]+$/, 'letters, digits, spaces, ._- only'),
  url: z.string().min(8).max(500),
  authToken: z.string().max(2_000).optional(),
});

const patchSchema = z
  .object({
    name: createSchema.shape.name.optional(),
    enabled: z.boolean().optional(),
    authToken: z.string().max(2_000).nullable().optional(), // null clears it
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'empty patch' });

/** Client-safe view: the token never leaves the backend. */
function publicServer(rec: McpServerRecord) {
  const { authToken, userId, ...rest } = rec;
  return { ...rest, hasAuth: Boolean(authToken) };
}

export async function listMcpServers(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const servers = await getStore().listMcpServers(claims.sub);
  return json(200, { servers: servers.map(publicServer) });
}

export async function createMcpServer(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw validationFailed('name (≤40 chars) and a valid URL are required');
  const { name, url, authToken } = parsed.data;
  assertAllowedMcpUrl(url);

  const store = getStore();
  const existing = await store.listMcpServers(claims.sub);
  if (existing.length >= config.maxMcpServersPerUser) {
    throw validationFailed(`Limit of ${config.maxMcpServersPerUser} connectors reached`);
  }

  // Probe on create so a bad URL/token fails loudly here, not mid-chat.
  const probe = await probeMcpServer(url, authToken);
  const now = new Date().toISOString();
  const rec: McpServerRecord = {
    serverId: newId(),
    userId: claims.sub,
    name,
    url,
    ...(authToken ? { authToken } : {}),
    enabled: probe.ok,
    tools: probe.ok ? probe.tools : [],
    status: probe.ok ? 'ok' : 'error',
    ...(probe.ok ? {} : { lastError: probe.error }),
    createdAt: now,
    lastCheckedAt: now,
  };
  await store.putMcpServer(rec);
  return json(201, { server: publicServer(rec) });
}

export async function refreshMcpServer(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const store = getStore();
  const rec = await store.getMcpServer(claims.sub, req.params['id'] ?? '');
  if (!rec) throw notFound('Connector');

  const probe = await probeMcpServer(rec.url, rec.authToken);
  const next: McpServerRecord = {
    ...rec,
    tools: probe.ok ? probe.tools : rec.tools,
    status: probe.ok ? 'ok' : 'error',
    lastError: probe.ok ? undefined : probe.error,
    lastCheckedAt: new Date().toISOString(),
  };
  await store.putMcpServer(next);
  return json(200, { server: publicServer(next) });
}

export async function updateMcpServer(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) throw validationFailed('nothing to update');

  const store = getStore();
  const rec = await store.getMcpServer(claims.sub, req.params['id'] ?? '');
  if (!rec) throw notFound('Connector');

  const next: McpServerRecord = { ...rec };
  if (parsed.data.name !== undefined) next.name = parsed.data.name;
  if (parsed.data.enabled !== undefined) next.enabled = parsed.data.enabled;
  if (parsed.data.authToken !== undefined) {
    if (parsed.data.authToken === null) delete next.authToken;
    else next.authToken = parsed.data.authToken;
    // Token changed → revalidate so status reflects reality.
    const probe = await probeMcpServer(next.url, next.authToken);
    next.tools = probe.ok ? probe.tools : next.tools;
    next.status = probe.ok ? 'ok' : 'error';
    next.lastError = probe.ok ? undefined : probe.error;
    next.lastCheckedAt = new Date().toISOString();
  }
  await store.putMcpServer(next);
  return json(200, { server: publicServer(next) });
}

export async function deleteMcpServer(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const store = getStore();
  const rec = await store.getMcpServer(claims.sub, req.params['id'] ?? '');
  if (!rec) throw notFound('Connector');
  await store.deleteMcpServer(claims.sub, rec.serverId);
  return json(200, { ok: true });
}
