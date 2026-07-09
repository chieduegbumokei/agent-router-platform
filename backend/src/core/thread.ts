import type { Message } from './types';

/**
 * Conversation branching (edit & regenerate) over a flat message list.
 *
 * Messages form a tree via `parentId` (null = root). Messages written before
 * branching existed have no `parentId` at all - their effective parent is the
 * previous message in stored order, which keeps every legacy conversation a
 * valid linear tree with zero migration.
 */

/** Effective parent id: explicit pointer, or the previous message (legacy). */
export function effectiveParents(all: Message[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (let i = 0; i < all.length; i++) {
    const m = all[i]!;
    parents.set(m.msgId, m.parentId !== undefined ? m.parentId : (all[i - 1]?.msgId ?? null));
  }
  return parents;
}

/** Root → `leafId` path. Returns null when leafId is unknown. */
export function pathTo(all: Message[], leafId: string): Message[] | null {
  const byId = new Map(all.map((m) => [m.msgId, m]));
  if (!byId.has(leafId)) return null;
  const parents = effectiveParents(all);

  const path: Message[] = [];
  let cursor: string | null = leafId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (seen.has(cursor)) break; // corrupt pointer - bail rather than loop
    seen.add(cursor);
    const msg = byId.get(cursor);
    if (!msg) break;
    path.push(msg);
    cursor = parents.get(cursor) ?? null;
  }
  return path.reverse();
}

/**
 * The default active path: from the latest root, always follow the most
 * recently created child. For a legacy linear conversation this is simply the
 * stored order; after an edit/regenerate it is the newest branch.
 */
export function defaultPath(all: Message[]): Message[] {
  if (all.length === 0) return [];
  const parents = effectiveParents(all);
  const children = new Map<string | null, Message[]>();
  for (const m of all) {
    const p = parents.get(m.msgId) ?? null;
    const list = children.get(p) ?? [];
    list.push(m); // stored order = creation order, so last entry is newest
    children.set(p, list);
  }

  const path: Message[] = [];
  let branch = children.get(null) ?? [];
  const seen = new Set<string>();
  while (branch.length > 0) {
    const next = branch[branch.length - 1]!;
    if (seen.has(next.msgId)) break;
    seen.add(next.msgId);
    path.push(next);
    branch = children.get(next.msgId) ?? [];
  }
  return path;
}
