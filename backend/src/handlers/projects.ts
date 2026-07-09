import { z } from 'zod';
import { config } from '../core/config';
import { notFound, validationFailed } from '../core/errors';
import { newId } from '../core/ids';
import { getStore } from '../store/index';
import type { ProjectRecord } from '../store/types';
import { json, requireAuth, type ApiRequest, type ApiResponse } from './http';

/**
 * Projects (Claude.ai-style): named workspaces that group conversations and
 * carry instructions injected into every chat inside them. All lookups are
 * keyed by the caller's userId; a miss is a 404 (same IDOR posture as
 * conversations - existence is never leaked).
 */

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(''),
  instructions: z.string().trim().max(4_000).default(''),
});

const patchSchema = z
  .object({
    name: createSchema.shape.name.optional(),
    description: z.string().trim().max(300).optional(),
    instructions: z.string().trim().max(4_000).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'empty patch' });

/** Client-safe view: userId stays server-side. */
function publicProject(rec: ProjectRecord) {
  const { userId, ...rest } = rec;
  return rest;
}

export async function listProjects(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const projects = await getStore().listProjects(claims.sub);
  return json(200, { projects: projects.map(publicProject) });
}

export async function getProject(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const rec = await getStore().getProject(claims.sub, req.params['id'] ?? '');
  if (!rec) throw notFound('Project');
  return json(200, { project: publicProject(rec) });
}

export async function createProject(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw validationFailed('name is required (max 60 chars)');

  const store = getStore();
  const existing = await store.listProjects(claims.sub);
  if (existing.length >= config.maxProjectsPerUser) {
    throw validationFailed(`Limit of ${config.maxProjectsPerUser} projects reached`);
  }

  const now = new Date().toISOString();
  const rec: ProjectRecord = {
    projectId: newId(),
    userId: claims.sub,
    name: parsed.data.name,
    description: parsed.data.description,
    instructions: parsed.data.instructions,
    createdAt: now,
    updatedAt: now,
  };
  await store.putProject(rec);
  return json(201, { project: publicProject(rec) });
}

export async function updateProject(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) throw validationFailed('nothing to update');

  const store = getStore();
  const rec = await store.getProject(claims.sub, req.params['id'] ?? '');
  if (!rec) throw notFound('Project');

  const next: ProjectRecord = {
    ...rec,
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    ...(parsed.data.instructions !== undefined ? { instructions: parsed.data.instructions } : {}),
    updatedAt: new Date().toISOString(),
  };
  await store.putProject(next);
  return json(200, { project: publicProject(next) });
}

export async function deleteProject(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const store = getStore();
  const rec = await store.getProject(claims.sub, req.params['id'] ?? '');
  if (!rec) throw notFound('Project');

  // Conversations survive: they are detached back to the ungrouped list.
  await store.deleteProject(claims.sub, rec.projectId);
  return json(200, { ok: true });
}
