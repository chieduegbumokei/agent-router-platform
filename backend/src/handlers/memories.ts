import { notFound } from '../core/errors';
import { getStore } from '../store/index';
import { json, requireAuth, type ApiRequest, type ApiResponse } from './http';

/**
 * Cross-session memory management (Settings → Memory). Users can see exactly
 * what the assistant remembers, delete single facts, or wipe everything -
 * the granular-privacy counterpart to the memoryEnabled toggle.
 */

export async function listMemories(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const memories = await getStore().listMemories(claims.sub);
  return json(200, {
    memories: memories.map((m) => ({
      memId: m.memId,
      content: m.content,
      sourceConvId: m.sourceConvId,
      createdAt: m.createdAt,
    })),
  });
}

export async function deleteMemory(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const memId = req.params['id'] ?? '';
  const existing = (await getStore().listMemories(claims.sub)).find((m) => m.memId === memId);
  if (!existing) throw notFound('Memory');
  await getStore().deleteMemory(claims.sub, memId);
  return json(200, { ok: true });
}

export async function deleteAllMemories(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  await getStore().deleteAllMemories(claims.sub);
  return json(200, { ok: true });
}
