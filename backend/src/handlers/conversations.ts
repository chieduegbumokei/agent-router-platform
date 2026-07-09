import { z } from 'zod';
import { notFound, validationFailed } from '../core/errors';
import { getStore } from '../store/index';
import { json, requireAuth, type ApiRequest, type ApiResponse } from './http';

export async function listConversations(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const conversations = await getStore().listConversations(claims.sub);
  return json(200, { conversations });
}

export async function listMessages(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const convId = req.params['id'] ?? '';

  // Ownership check first (IDOR): the lookup is keyed by the caller's userId,
  // and a miss returns 404 - never 403, which would leak existence.
  const conv = await getStore().getConversation(claims.sub, convId);
  if (!conv) throw notFound('Conversation');

  const messages = await getStore().listMessages(convId, 200);
  return json(200, { conversation: conv, messages });
}

/* ---- history search ------------------------------------------------------ */

const SEARCH_CONV_LIMIT = 30; // newest conversations scanned per query
const SEARCH_RESULT_LIMIT = 20;

function snippetAround(text: string, index: number, needleLen: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + needleLen + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

/**
 * GET /conversations/search?q= - case-insensitive search over titles and
 * message bodies. Titles match from the in-memory list; bodies are scanned for
 * the newest N conversations (bounded work per request). Production path:
 * DynamoDB Streams → OpenSearch (docs/LLD.md).
 */
export async function searchConversations(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const q = (req.query['q'] ?? '').trim().toLowerCase();
  if (q.length < 2 || q.length > 200) throw validationFailed('q must be 2-200 characters');

  const store = getStore();
  const conversations = await store.listConversations(claims.sub);
  const results: Array<{
    convId: string;
    title: string;
    matchedIn: 'title' | 'message';
    snippet?: string;
    lastMessageAt: string;
  }> = [];

  for (const conv of conversations) {
    if (conv.title.toLowerCase().includes(q)) {
      results.push({
        convId: conv.convId,
        title: conv.title,
        matchedIn: 'title',
        lastMessageAt: conv.lastMessageAt,
      });
    }
    if (results.length >= SEARCH_RESULT_LIMIT) return json(200, { results });
  }

  const matchedIds = new Set(results.map((r) => r.convId));
  for (const conv of conversations.slice(0, SEARCH_CONV_LIMIT)) {
    if (matchedIds.has(conv.convId)) continue;
    const messages = await store.listMessages(conv.convId, 200);
    for (const msg of messages) {
      const idx = msg.content.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      results.push({
        convId: conv.convId,
        title: conv.title,
        matchedIn: 'message',
        snippet: snippetAround(msg.content, idx, q.length),
        lastMessageAt: conv.lastMessageAt,
      });
      break; // first hit per conversation is enough
    }
    if (results.length >= SEARCH_RESULT_LIMIT) break;
  }

  return json(200, { results });
}

/* ---- update (rename / move to project) / delete -------------------------- */

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    /** Move into a project; null detaches back to the ungrouped list. */
    projectId: z.string().uuid().nullable().optional(),
    starred: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'empty patch' });

export async function updateConversation(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const convId = req.params['id'] ?? '';
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw validationFailed('title (1-80 chars), projectId, or starred is required');

  const store = getStore();
  const conv = await store.getConversation(claims.sub, convId);
  if (!conv) throw notFound('Conversation');

  if (parsed.data.title !== undefined) {
    await store.renameConversation(claims.sub, convId, parsed.data.title);
  }
  if (parsed.data.projectId !== undefined) {
    if (parsed.data.projectId !== null) {
      const project = await store.getProject(claims.sub, parsed.data.projectId);
      if (!project) throw notFound('Project');
    }
    await store.setConversationProject(claims.sub, convId, parsed.data.projectId);
  }
  if (parsed.data.starred !== undefined) {
    await store.setConversationStarred(claims.sub, convId, parsed.data.starred);
  }
  return json(200, { ok: true });
}

export async function deleteConversation(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const convId = req.params['id'] ?? '';

  const store = getStore();
  const conv = await store.getConversation(claims.sub, convId);
  if (!conv) throw notFound('Conversation');

  await store.deleteConversation(claims.sub, convId);
  return json(200, { ok: true });
}

/** Privacy control: wipe the user's entire conversation history. */
export async function deleteAllConversations(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const store = getStore();
  const conversations = await store.listConversations(claims.sub);
  for (const conv of conversations) {
    await store.deleteConversation(claims.sub, conv.convId);
  }
  return json(200, { ok: true, deleted: conversations.length });
}

/* ---- message feedback ---------------------------------------------------- */

const feedbackSchema = z.object({
  rating: z.enum(['up', 'down']).nullable(),
  comment: z.string().max(1_000).optional(),
});

/** POST /conversations/:id/messages/:msgId/feedback - thumbs + optional note. */
export async function messageFeedback(req: ApiRequest): Promise<ApiResponse> {
  const claims = requireAuth(req);
  const convId = req.params['id'] ?? '';
  const msgId = req.params['msgId'] ?? '';
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) throw validationFailed('rating must be "up", "down", or null');

  const store = getStore();
  const conv = await store.getConversation(claims.sub, convId);
  if (!conv) throw notFound('Conversation');

  await store.updateMessageFeedback(convId, msgId, {
    feedback: parsed.data.rating,
    ...(parsed.data.comment !== undefined ? { feedbackComment: parsed.data.comment } : {}),
  });
  return json(200, { ok: true });
}
