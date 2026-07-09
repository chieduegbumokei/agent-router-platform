import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../src/store/types';
import { createMemoryStore } from '../src/store/memory';

let store: Store;
beforeEach(() => {
  store = createMemoryStore();
});

describe('conversation ownership (IDOR)', () => {
  it("user A cannot read user B's conversation", async () => {
    await store.createConversation({
      convId: 'conv-1',
      userId: 'user-b',
      title: 'secret',
      createdAt: '2026-01-01T00:00:00Z',
      lastMessageAt: '2026-01-01T00:00:00Z',
    });
    expect(await store.getConversation('user-a', 'conv-1')).toBeNull();
    expect(await store.getConversation('user-b', 'conv-1')).not.toBeNull();
  });
});

describe('messages', () => {
  it('returns messages oldest → newest and respects the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.addMessage({
        msgId: `m${i}`,
        convId: 'c1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
        createdAt: `2026-01-01T00:0${i}:00Z`,
      });
    }
    const last3 = await store.listMessages('c1', 3);
    expect(last3.map((m) => m.content)).toEqual(['message 2', 'message 3', 'message 4']);
  });
});

describe('conversation listing', () => {
  it('lists newest-first per user only', async () => {
    const mk = (convId: string, userId: string, at: string) =>
      store.createConversation({
        convId,
        userId,
        title: convId,
        createdAt: at,
        lastMessageAt: at,
      });
    await mk('old', 'u1', '2026-01-01T00:00:00Z');
    await mk('new', 'u1', '2026-02-01T00:00:00Z');
    await mk('other', 'u2', '2026-03-01T00:00:00Z');

    const list = await store.listConversations('u1');
    expect(list.map((c) => c.convId)).toEqual(['new', 'old']);
  });
});
