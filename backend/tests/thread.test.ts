import { describe, expect, it } from 'vitest';
import { defaultPath, pathTo } from '../src/core/thread';
import type { Message } from '../src/core/types';

/** Legacy message: no parentId field at all (pre-branching rows). */
const legacy = (msgId: string, role: 'user' | 'assistant'): Message => ({
  msgId,
  convId: 'c1',
  role,
  content: msgId,
  createdAt: '2026-01-01T00:00:00Z',
});

const branched = (msgId: string, role: 'user' | 'assistant', parentId: string | null): Message => ({
  ...legacy(msgId, role),
  parentId,
});

describe('thread branching math', () => {
  it('treats legacy conversations as a linear chain', () => {
    const all = [legacy('u1', 'user'), legacy('a2', 'assistant'), legacy('u3', 'user'), legacy('a4', 'assistant')];
    expect(defaultPath(all).map((m) => m.msgId)).toEqual(['u1', 'a2', 'u3', 'a4']);
    expect(pathTo(all, 'u3')?.map((m) => m.msgId)).toEqual(['u1', 'a2', 'u3']);
  });

  it('follows the newest branch after a regenerate', () => {
    const all = [
      legacy('u1', 'user'),
      legacy('a2', 'assistant'),
      legacy('u3', 'user'),
      legacy('a4', 'assistant'),
      branched('a5', 'assistant', 'u3'), // regenerated answer to u3
    ];
    expect(defaultPath(all).map((m) => m.msgId)).toEqual(['u1', 'a2', 'u3', 'a5']);
    // the old branch stays reachable
    expect(pathTo(all, 'a4')?.map((m) => m.msgId)).toEqual(['u1', 'a2', 'u3', 'a4']);
  });

  it('follows an edited-message branch from its fork point', () => {
    const all = [
      legacy('u1', 'user'),
      legacy('a2', 'assistant'),
      legacy('u3', 'user'),
      legacy('a4', 'assistant'),
      branched('u5', 'user', 'a2'), // u3 edited → sibling branch under a2
      branched('a6', 'assistant', 'u5'),
    ];
    expect(defaultPath(all).map((m) => m.msgId)).toEqual(['u1', 'a2', 'u5', 'a6']);
    expect(pathTo(all, 'a4')?.map((m) => m.msgId)).toEqual(['u1', 'a2', 'u3', 'a4']);
  });

  it('handles explicit null parents as roots and unknown leaves', () => {
    const all = [branched('u1', 'user', null), branched('a2', 'assistant', 'u1'), branched('u3', 'user', null)];
    // newest root wins the default path
    expect(defaultPath(all).map((m) => m.msgId)).toEqual(['u3']);
    expect(pathTo(all, 'missing')).toBeNull();
  });
});
