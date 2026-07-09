import type { ApiMessage } from './types';

/**
 * Conversation branching math (mirrors backend/src/core/thread.ts).
 *
 * Messages form a tree via `parentId`; legacy messages (no parentId field)
 * chain onto the previous message in stored order. The UI renders one
 * root→leaf path at a time and lets the user hop between sibling branches.
 */

export function effectiveParents(all: ApiMessage[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (let i = 0; i < all.length; i++) {
    const m = all[i]!;
    parents.set(m.msgId, m.parentId !== undefined ? m.parentId : (all[i - 1]?.msgId ?? null));
  }
  return parents;
}

function childrenMap(all: ApiMessage[]): Map<string | null, ApiMessage[]> {
  const parents = effectiveParents(all);
  const children = new Map<string | null, ApiMessage[]>();
  for (const m of all) {
    const p = parents.get(m.msgId) ?? null;
    const list = children.get(p) ?? [];
    list.push(m); // stored order = creation order → last is newest
    children.set(p, list);
  }
  return children;
}

/** Follow the newest child from `start` (exclusive) down to a leaf. */
function descendNewest(
  children: Map<string | null, ApiMessage[]>,
  start: string | null,
  seen: Set<string>,
): ApiMessage[] {
  const path: ApiMessage[] = [];
  let branch = children.get(start) ?? [];
  while (branch.length > 0) {
    const next = branch[branch.length - 1]!;
    if (seen.has(next.msgId)) break;
    seen.add(next.msgId);
    path.push(next);
    branch = children.get(next.msgId) ?? [];
  }
  return path;
}

/** Default active path: newest branch at every fork. */
export function defaultPath(all: ApiMessage[]): ApiMessage[] {
  return descendNewest(childrenMap(all), null, new Set());
}

/** Root→nodeId, then continue along the newest children to a leaf. */
export function pathThrough(all: ApiMessage[], nodeId: string): ApiMessage[] {
  const byId = new Map(all.map((m) => [m.msgId, m]));
  if (!byId.has(nodeId)) return defaultPath(all);
  const parents = effectiveParents(all);

  const up: ApiMessage[] = [];
  const seen = new Set<string>();
  let cursor: string | null = nodeId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const msg = byId.get(cursor);
    if (!msg) break;
    up.push(msg);
    cursor = parents.get(cursor) ?? null;
  }
  up.reverse();
  return [...up, ...descendNewest(childrenMap(all), nodeId, seen)];
}

/** Ordered siblings sharing this message's effective parent (length ≥ 1). */
export function siblingsOf(all: ApiMessage[], nodeId: string): ApiMessage[] {
  const parents = effectiveParents(all);
  if (!parents.has(nodeId)) return [];
  const parent = parents.get(nodeId) ?? null;
  return all.filter((m) => (parents.get(m.msgId) ?? null) === parent && m.role === (all.find((x) => x.msgId === nodeId)?.role ?? 'user'));
}
