import { z } from 'zod';
import { validationFailed } from '../core/errors';
import { getStore } from '../store/index';
import { DEFAULT_SETTINGS } from '../store/types';
import { json, requireAuth, type ApiRequest, type ApiResponse } from './http';

/**
 * Personalization + privacy settings. customInstructions is injected into
 * every agent's system prompt; memoryEnabled gates cross-session memory in
 * both directions (read and write).
 */

const patchSchema = z
  .object({
    customInstructions: z.string().max(2_000).optional(),
    memoryEnabled: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'empty patch' });

const publicSettings = (s: { customInstructions: string; memoryEnabled: boolean }) => ({
  customInstructions: s.customInstructions,
  memoryEnabled: s.memoryEnabled,
});

export async function getSettings(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const settings = (await getStore().getUserSettings(claims.sub)) ?? DEFAULT_SETTINGS(claims.sub);
  return json(200, { settings: publicSettings(settings) });
}

export async function updateSettings(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) throw validationFailed('nothing to update (customInstructions ≤ 2000 chars)');

  const store = getStore();
  const current = (await store.getUserSettings(claims.sub)) ?? DEFAULT_SETTINGS(claims.sub);
  const next = {
    ...current,
    ...(parsed.data.customInstructions !== undefined
      ? { customInstructions: parsed.data.customInstructions.trim() }
      : {}),
    ...(parsed.data.memoryEnabled !== undefined ? { memoryEnabled: parsed.data.memoryEnabled } : {}),
    updatedAt: new Date().toISOString(),
  };
  await store.putUserSettings(next);
  return json(200, { settings: publicSettings(next) });
}
