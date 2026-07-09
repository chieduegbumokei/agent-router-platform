import { beforeEach, describe, expect, it } from 'vitest';
import { signup } from '../src/handlers/auth';
import { chat } from '../src/handlers/chat';
import { listMessages } from '../src/handlers/conversations';
import type { ApiRequest, SseWriter } from '../src/handlers/http';
import type { StreamEvent } from '../src/core/types';
import { createMockClient } from '../src/llm/mock';
import { setLlm } from '../src/llm/index';
import { createMemoryStore } from '../src/store/memory';
import { setStore } from '../src/store/index';

let ipCounter = 0;

async function makeUser(): Promise<string> {
  const res = await signup({
    method: 'POST',
    path: '/auth/signup',
    params: {},
    query: {},
    headers: {},
    body: { email: `user${++ipCounter}@test.com`, password: 'password123' },
    ip: `10.1.0.${ipCounter}`,
  });
  return (res.body as { accessToken: string }).accessToken;
}

const chatReq = (token: string, body: unknown): ApiRequest => ({
  method: 'POST',
  path: '/chat',
  params: {},
  query: {},
  headers: { authorization: `Bearer ${token}` },
  body,
  ip: '10.1.1.1',
});

function makeSse(): { sse: SseWriter; events: StreamEvent[]; closed: () => boolean } {
  const events: StreamEvent[] = [];
  let closed = false;
  return {
    events,
    closed: () => closed,
    sse: {
      write: (e) => events.push(e),
      close: () => {
        closed = true;
      },
      signal: new AbortController().signal,
    },
  };
}

beforeEach(() => {
  setStore(createMemoryStore());
  setLlm(createMockClient());
});

describe('chat streaming end-to-end (mock LLM)', () => {
  it('streams routing → tokens → done, and persists both messages', async () => {
    const token = await makeUser();
    const { sse, events, closed } = makeSse();

    await chat(chatReq(token, { message: 'help me debug this javascript function' }), sse);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('routing');
    expect(types).toContain('token');
    expect(types[types.length - 1]).toBe('done');
    expect(closed()).toBe(true);

    const routing = events[0] as Extract<StreamEvent, { type: 'routing' }>;
    expect(routing.agent).toBe('coding'); // mock classifier keys off "debug"/"javascript"
    expect(routing.conversationId).toBeTruthy();

    // both sides of the exchange persisted
    const msgRes = await listMessages({
      method: 'GET',
      path: `/conversations/${routing.conversationId}/messages`,
      params: { id: routing.conversationId },
      query: {},
      headers: { authorization: `Bearer ${token}` },
      body: null,
      ip: '10.1.1.1',
    });
    const { messages } = msgRes.body as { messages: Array<{ role: string; agentId?: string }> };
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.agentId).toBe('coding');
  });

  it('rejects unauthenticated requests before any streaming', async () => {
    const { sse, events } = makeSse();
    await expect(
      chat(chatReq('not-a-real-token', { message: 'hello' }), sse),
    ).rejects.toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
    expect(events).toHaveLength(0); // nothing leaked onto the stream
  });

  it("404s when continuing another user's conversation (IDOR)", async () => {
    const tokenA = await makeUser();
    const tokenB = await makeUser();

    const first = makeSse();
    await chat(chatReq(tokenA, { message: 'hello there' }), first.sse);
    const convId = (first.events[0] as Extract<StreamEvent, { type: 'routing' }>).conversationId;

    const second = makeSse();
    await expect(
      chat(chatReq(tokenB, { conversationId: convId, message: 'let me in' }), second.sse),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('turns a mid-stream LLM failure into an in-band error event', async () => {
    const token = await makeUser();
    // classifier succeeds via fallback path? No - make every LLM call fail:
    setLlm(createMockClient({ failWith: new Error('bedrock exploded') }));
    const { sse, events, closed } = makeSse();

    await chat(chatReq(token, { message: 'hello' }), sse); // must NOT throw
    const last = events[events.length - 1];
    expect(last?.type).toBe('error');
    expect((last as Extract<StreamEvent, { type: 'error' }>).message).not.toContain('exploded'); // safe message only
    expect(closed()).toBe(true);
  });

  it('continues an existing conversation with history', async () => {
    const token = await makeUser();
    const first = makeSse();
    await chat(chatReq(token, { message: 'first message here' }), first.sse);
    const convId = (first.events[0] as Extract<StreamEvent, { type: 'routing' }>).conversationId;

    const second = makeSse();
    await chat(chatReq(token, { conversationId: convId, message: 'second message here' }), second.sse);
    expect(second.events.map((e) => e.type)).toContain('done');

    const msgRes = await listMessages({
      method: 'GET',
      path: `/conversations/${convId}/messages`,
      params: { id: convId },
      query: {},
      headers: { authorization: `Bearer ${token}` },
      body: null,
      ip: '10.1.1.1',
    });
    const { messages } = msgRes.body as { messages: unknown[] };
    expect(messages).toHaveLength(4); // user, assistant, user, assistant
  });
});
