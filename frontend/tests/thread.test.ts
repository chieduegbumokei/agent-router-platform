import { describe, expect, it } from 'vitest';
import { defaultPath, pathThrough, siblingsOf } from '../src/lib/thread';
import type { ApiMessage } from '../src/lib/types';

const legacy = (msgId: string, role: 'user' | 'assistant'): ApiMessage => ({
  msgId,
  convId: 'c1',
  role,
  content: msgId,
  createdAt: '2026-01-01T00:00:00Z',
});

const branched = (msgId: string, role: 'user' | 'assistant', parentId: string | null): ApiMessage => ({
  ...legacy(msgId, role),
  parentId,
});

// legacy chain u1→a2→u3→a4, then a5 = regenerated answer to u3
const withRegen = [
  legacy('u1', 'user'),
  legacy('a2', 'assistant'),
  legacy('u3', 'user'),
  legacy('a4', 'assistant'),
  branched('a5', 'assistant', 'u3'),
];

describe('thread tree (frontend mirror)', () => {
  it('renders legacy conversations linearly', () => {
    const all = withRegen.slice(0, 4);
    expect(defaultPath(all).map((m) => m.msgId)).toEqual(['u1', 'a2', 'u3', 'a4']);
  });

  it('prefers the newest sibling and can walk back to older branches', () => {
    expect(defaultPath(withRegen).map((m) => m.msgId)).toEqual(['u1', 'a2', 'u3', 'a5']);
    expect(pathThrough(withRegen, 'a4').map((m) => m.msgId)).toEqual(['u1', 'a2', 'u3', 'a4']);
  });

  it('continues past the target down the newest sub-branch', () => {
    const all = [
      ...withRegen,
      branched('u6', 'user', 'a4'), // follow-up on the OLD branch
      branched('a7', 'assistant', 'u6'),
    ];
    expect(pathThrough(all, 'a4').map((m) => m.msgId)).toEqual(['u1', 'a2', 'u3', 'a4', 'u6', 'a7']);
  });

  it('lists same-role siblings in creation order', () => {
    expect(siblingsOf(withRegen, 'a4').map((m) => m.msgId)).toEqual(['a4', 'a5']);
    expect(siblingsOf(withRegen, 'a5').map((m) => m.msgId)).toEqual(['a4', 'a5']);
    expect(siblingsOf(withRegen, 'u3')).toHaveLength(1); // no user siblings yet
  });

  it('treats an edited message as a sibling under the fork point', () => {
    const all = [...withRegen.slice(0, 4), branched('u5', 'user', 'a2'), branched('a6', 'assistant', 'u5')];
    expect(defaultPath(all).map((m) => m.msgId)).toEqual(['u1', 'a2', 'u5', 'a6']);
    expect(siblingsOf(all, 'u5').map((m) => m.msgId)).toEqual(['u3', 'u5']);
  });
});
