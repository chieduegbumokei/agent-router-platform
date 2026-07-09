import { beforeEach, describe, expect, it } from 'vitest';
import { signup } from '../src/handlers/auth';
import { chat } from '../src/handlers/chat';
import {
  deleteAllConversations,
  deleteConversation,
  listConversations,
  listMessages,
  messageFeedback,
  updateConversation,
  searchConversations,
} from '../src/handlers/conversations';
import { deleteAllMemories, listMemories } from '../src/handlers/memories';
import { getSettings, updateSettings } from '../src/handlers/settings';
import type { ApiRequest, SseWriter } from '../src/handlers/http';
import type { Message, StreamEvent } from '../src/core/types';
import { createMockClient } from '../src/llm/mock';
import { setLlm } from '../src/llm/index';
import { createMemoryStore } from '../src/store/memory';
import { setStore } from '../src/store/index';

let ipCounter = 100;

async function makeUser(): Promise<string> {
  const res = await signup(req('POST', '/auth/signup', {
    body: { email: `feat${++ipCounter}@test.com`, password: 'password123' },
    ip: `10.2.0.${ipCounter % 250}`,
  }));
  return (res.body as { accessToken: string }).accessToken;
}

function req(
  method: string,
  path: string,
  extra: Partial<ApiRequest> & { token?: string } = {},
): ApiRequest {
  const { token, ...rest } = extra;
  return {
    method,
    path,
    params: {},
    query: {},
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: null,
    ip: '10.2.1.1',
    ...rest,
  };
}

function makeSse(): { sse: SseWriter; events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  return {
    events,
    sse: {
      write: (e) => events.push(e),
      close: () => undefined,
      signal: new AbortController().signal,
    },
  };
}

const routingOf = (events: StreamEvent[]) =>
  events.find((e) => e.type === 'routing') as Extract<StreamEvent, { type: 'routing' }>;
const doneOf = (events: StreamEvent[]) =>
  events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>;

async function sendChat(token: string, body: unknown) {
  const { sse, events } = makeSse();
  await chat(req('POST', '/chat', { token, body }), sse);
  return events;
}

beforeEach(() => {
  setStore(createMemoryStore());
  setLlm(createMockClient());
});

/* ------------------------------------------------------------------------ */

describe('edit & regenerate branching', () => {
  it('creates sibling branches and serves the newest one by default', async () => {
    const token = await makeUser();

    const first = await sendChat(token, { message: 'what is the meaning of life' });
    const convId = routingOf(first).conversationId;
    const u1 = routingOf(first).userMessageId;
    expect(u1).toBeTruthy();

    // Edit the root message → a sibling root branch (parentMessageId: null)
    const second = await sendChat(token, {
      conversationId: convId,
      message: 'what is the meaning of everything',
      parentMessageId: null,
    });
    const u2 = routingOf(second).userMessageId;

    // Regenerate the answer to the edited message → sibling assistant
    const third = await sendChat(token, {
      conversationId: convId,
      regenerate: true,
      parentMessageId: u2,
    });
    expect(routingOf(third).userMessageId).toBe(u2);

    const msgRes = await listMessages(
      req('GET', `/conversations/${convId}/messages`, { token, params: { id: convId } }),
    );
    const { messages } = msgRes.body as { messages: Message[] };
    expect(messages).toHaveLength(5); // u1, a1, u2, a2, a3(regen)

    const u2msg = messages.find((m) => m.msgId === u2)!;
    expect(u2msg.parentId).toBeNull();
    const answersToU2 = messages.filter((m) => m.parentId === u2 && m.role === 'assistant');
    expect(answersToU2).toHaveLength(2); // original + regenerated
  });

  it('rejects regenerating a non-user message', async () => {
    const token = await makeUser();
    const first = await sendChat(token, { message: 'hello there' });
    const convId = routingOf(first).conversationId;
    const assistantId = doneOf(first).messageId;

    const { sse } = makeSse();
    await expect(
      chat(req('POST', '/chat', { token, body: { conversationId: convId, regenerate: true, parentMessageId: assistantId } }), sse),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('incognito (ephemeral) chats', () => {
  it('persists nothing and echoes no conversation id', async () => {
    const token = await makeUser();
    const events = await sendChat(token, {
      message: 'secret question',
      ephemeral: true,
      clientHistory: [{ role: 'user', content: 'earlier context' }, { role: 'assistant', content: 'earlier answer' }],
    });
    expect(routingOf(events).conversationId).toBe('');
    expect(events.some((e) => e.type === 'done')).toBe(true);

    const list = await listConversations(req('GET', '/conversations', { token }));
    expect((list.body as { conversations: unknown[] }).conversations).toHaveLength(0);
  });
});

describe('attachments', () => {
  const tinyPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('feeds images to the model and persists metadata only', async () => {
    const token = await makeUser();
    const events = await sendChat(token, {
      message: 'what is in this image',
      attachments: [{ name: 'pixel.png', mediaType: 'image/png', kind: 'image', dataBase64: tinyPng }],
    });
    const text = events
      .filter((e): e is Extract<StreamEvent, { type: 'token' }> => e.type === 'token')
      .map((e) => e.text)
      .join('');
    expect(text).toContain('[mock: received 1 image]');

    const convId = routingOf(events).conversationId;
    const msgRes = await listMessages(
      req('GET', `/conversations/${convId}/messages`, { token, params: { id: convId } }),
    );
    const { messages } = msgRes.body as { messages: Message[] };
    const userMsg = messages.find((m) => m.role === 'user')!;
    expect(userMsg.attachments).toEqual([
      { name: 'pixel.png', mediaType: 'image/png', kind: 'image', size: expect.any(Number) },
    ]);
    expect(JSON.stringify(userMsg)).not.toContain(tinyPng); // bytes never stored
  });

  it('rejects unsupported attachment types', async () => {
    const token = await makeUser();
    const { sse } = makeSse();
    await expect(
      chat(
        req('POST', '/chat', {
          token,
          body: {
            message: 'run this',
            attachments: [{ name: 'app.exe', mediaType: 'application/x-msdownload', kind: 'image', dataBase64: 'AAAA' }],
          },
        }),
        sse,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('cross-session memory', () => {
  it('extracts facts, emits a memory event, and dedupes on repeat', async () => {
    const token = await makeUser();
    const events = await sendChat(token, { message: 'Remember that I prefer TypeScript for all examples' });
    const memoryEvent = events.find((e) => e.type === 'memory') as Extract<StreamEvent, { type: 'memory' }>;
    expect(memoryEvent).toBeTruthy();
    expect(memoryEvent.saved[0]!.toLowerCase()).toContain('typescript');

    const listed = await listMemories(req('GET', '/memories', { token }));
    expect((listed.body as { memories: unknown[] }).memories).toHaveLength(1);

    // same fact again → known-set dedupe, no second memory
    const again = await sendChat(token, { message: 'Remember that I prefer TypeScript for all examples' });
    expect(again.some((e) => e.type === 'memory')).toBe(false);
  });

  it('respects the memoryEnabled=false setting', async () => {
    const token = await makeUser();
    await updateSettings(req('PATCH', '/settings', { token, body: { memoryEnabled: false } }));
    const events = await sendChat(token, { message: 'Remember that my name is Dana' });
    expect(events.some((e) => e.type === 'memory')).toBe(false);
    const listed = await listMemories(req('GET', '/memories', { token }));
    expect((listed.body as { memories: unknown[] }).memories).toHaveLength(0);
  });

  it('supports wiping all memories', async () => {
    const token = await makeUser();
    await sendChat(token, { message: 'Remember that I work at Cross River' });
    await deleteAllMemories(req('DELETE', '/memories', { token }));
    const listed = await listMemories(req('GET', '/memories', { token }));
    expect((listed.body as { memories: unknown[] }).memories).toHaveLength(0);
  });
});

describe('settings & custom instructions', () => {
  it('round-trips custom instructions and injects defaults for new users', async () => {
    const token = await makeUser();
    const initial = await getSettings(req('GET', '/settings', { token }));
    expect((initial.body as { settings: { memoryEnabled: boolean } }).settings.memoryEnabled).toBe(true);

    const updated = await updateSettings(
      req('PATCH', '/settings', { token, body: { customInstructions: 'Answer like a senior engineer.' } }),
    );
    expect((updated.body as { settings: { customInstructions: string } }).settings.customInstructions).toBe(
      'Answer like a senior engineer.',
    );
  });
});

describe('history search, rename, delete', () => {
  it('finds conversations by title and by message content', async () => {
    const token = await makeUser();
    await sendChat(token, { message: 'tell me about quantum computing please' });
    await sendChat(token, { message: 'how do airplanes fly' });

    const byTitle = await searchConversations(req('GET', '/conversations/search', { token, query: { q: 'quantum' } }));
    const titleResults = (byTitle.body as { results: Array<{ matchedIn: string }> }).results;
    expect(titleResults.length).toBeGreaterThan(0);
    expect(titleResults[0]!.matchedIn).toBe('title');

    // mock replies embed the question → content search hits the assistant message
    const byContent = await searchConversations(
      req('GET', '/conversations/search', { token, query: { q: 'mock response to: "how do airplanes' } }),
    );
    expect((byContent.body as { results: unknown[] }).results.length).toBeGreaterThan(0);
  });

  it('renames and deletes with IDOR-safe 404s', async () => {
    const tokenA = await makeUser();
    const tokenB = await makeUser();
    const events = await sendChat(tokenA, { message: 'rename me later' });
    const convId = routingOf(events).conversationId;

    await expect(
      updateConversation(req('PATCH', `/conversations/${convId}`, { token: tokenB, params: { id: convId }, body: { title: 'stolen' } })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await updateConversation(
      req('PATCH', `/conversations/${convId}`, { token: tokenA, params: { id: convId }, body: { title: 'My renamed chat' } }),
    );
    const list = await listConversations(req('GET', '/conversations', { token: tokenA }));
    expect((list.body as { conversations: Array<{ title: string }> }).conversations[0]!.title).toBe('My renamed chat');

    await deleteConversation(req('DELETE', `/conversations/${convId}`, { token: tokenA, params: { id: convId } }));
    await expect(
      listMessages(req('GET', `/conversations/${convId}/messages`, { token: tokenA, params: { id: convId } })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stars and unstars a conversation', async () => {
    const token = await makeUser();
    const events = await sendChat(token, { message: 'star me' });
    const convId = routingOf(events).conversationId;

    await updateConversation(
      req('PATCH', `/conversations/${convId}`, { token, params: { id: convId }, body: { starred: true } }),
    );
    let list = await listConversations(req('GET', '/conversations', { token }));
    expect((list.body as { conversations: Array<{ starred?: boolean }> }).conversations[0]!.starred).toBe(true);

    await updateConversation(
      req('PATCH', `/conversations/${convId}`, { token, params: { id: convId }, body: { starred: false } }),
    );
    list = await listConversations(req('GET', '/conversations', { token }));
    expect((list.body as { conversations: Array<{ starred?: boolean }> }).conversations[0]!.starred).toBeUndefined();
  });

  it('clears all conversations at once', async () => {
    const token = await makeUser();
    await sendChat(token, { message: 'one' });
    await sendChat(token, { message: 'two' });
    const res = await deleteAllConversations(req('DELETE', '/conversations', { token }));
    expect((res.body as { deleted: number }).deleted).toBe(2);
    const list = await listConversations(req('GET', '/conversations', { token }));
    expect((list.body as { conversations: unknown[] }).conversations).toHaveLength(0);
  });
});

describe('message feedback', () => {
  it('stores thumbs ratings with optional comments and clears them', async () => {
    const token = await makeUser();
    const events = await sendChat(token, { message: 'rate this answer' });
    const convId = routingOf(events).conversationId;
    const msgId = doneOf(events).messageId;
    const fbReq = (body: unknown) =>
      req('POST', `/conversations/${convId}/messages/${msgId}/feedback`, {
        token,
        params: { id: convId, msgId },
        body,
      });

    await messageFeedback(fbReq({ rating: 'down', comment: 'too vague' }));
    let msgRes = await listMessages(req('GET', `/conversations/${convId}/messages`, { token, params: { id: convId } }));
    let assistant = (msgRes.body as { messages: Message[] }).messages.find((m) => m.msgId === msgId)!;
    expect(assistant.feedback).toBe('down');
    expect(assistant.feedbackComment).toBe('too vague');

    await messageFeedback(fbReq({ rating: null }));
    msgRes = await listMessages(req('GET', `/conversations/${convId}/messages`, { token, params: { id: convId } }));
    assistant = (msgRes.body as { messages: Message[] }).messages.find((m) => m.msgId === msgId)!;
    expect(assistant.feedback).toBeUndefined();
  });
});
