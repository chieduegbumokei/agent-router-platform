import { AGENTS } from '../agents/registry';
import { json, requireAuth, type ApiRequest, type ApiResponse } from './http';

/**
 * Registry metadata for the UI's live pipeline view. Generated from the same
 * registry the router uses, so a newly added agent shows up in the canvas
 * with zero frontend changes.
 */
export async function listAgents(req: ApiRequest): Promise<ApiResponse> {
  requireAuth(req);
  const agents = Object.values(AGENTS).map((a) => ({
    id: a.id,
    displayName: a.displayName,
    description: a.description,
    tools: a.tools.map((t) => t.name),
  }));
  return json(200, { agents });
}
