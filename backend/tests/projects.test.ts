import { beforeEach, describe, expect, it } from 'vitest';
import { signup } from '../src/handlers/auth';
import { chat } from '../src/handlers/chat';
import { listConversations, updateConversation } from '../src/handlers/conversations';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../src/handlers/projects';
import type { ApiRequest, SseWriter } from '../src/handlers/http';
import type { StreamEvent } from '../src/core/types';
import type { LlmChunk, LlmClient, LlmStreamRequest } from '../src/llm/types';
import { createMockClient } from '../src/llm/mock';
import { setLlm } from '../src/llm/index';
import { createMemoryStore } from '../src/store/memory';
import { setStore } from '../src/store/index';
import type { ConversationRecord, ProjectRecord } from '../src/store/types';

let ipCounter = 300;

async function makeUser(): Promise<string> {
  const res = await signup(req('POST', '/auth/signup', {
    body: { email: `proj${++ipCounter}@test.com`, password: 'password123' },
    ip: `10.3.0.${ipCounter % 250}`,
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
    ip: '10.3.1.1',
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

async function sendChat(token: string, body: unknown) {
  const { sse, events } = makeSse();
  await chat(req('POST', '/chat', { token, body }), sse);
  return events;
}

/** Mock LLM that also records every request (to inspect the system prompt). */
function recordingLlm(): { llm: LlmClient; requests: LlmStreamRequest[] } {
  const inner = createMockClient();
  const requests: LlmStreamRequest[] = [];
  return {
    requests,
    llm: {
      async *converseStream(request): AsyncIterable<LlmChunk> {
        requests.push(request);
        yield* inner.converseStream(request);
      },
    },
  };
}

async function makeProject(token: string, body: unknown): Promise<ProjectRecord> {
  const res = await createProject(req('POST', '/projects', { token, body }));
  expect(res.status).toBe(201);
  return (res.body as { project: ProjectRecord }).project;
}

const listConvs = async (token: string) =>
  ((await listConversations(req('GET', '/conversations', { token }))).body as {
    conversations: ConversationRecord[];
  }).conversations;

beforeEach(() => {
  setStore(createMemoryStore());
  setLlm(createMockClient());
});

/* ------------------------------------------------------------------------ */

describe('project CRUD', () => {
  it('creates, lists, updates, and deletes a project', async () => {
    const token = await makeUser();

    const created = await makeProject(token, {
      name: 'Loan research',
      description: 'Pricing work',
      instructions: 'Always answer in bullet points.',
    });
    expect(created.projectId).toBeTruthy();
    expect((created as { userId?: string }).userId).toBeUndefined(); // never leaked

    const list = await listProjects(req('GET', '/projects', { token }));
    expect((list.body as { projects: ProjectRecord[] }).projects).toHaveLength(1);

    const fetched = await getProject(
      req('GET', `/projects/${created.projectId}`, { token, params: { id: created.projectId } }),
    );
    expect((fetched.body as { project: ProjectRecord }).project.name).toBe('Loan research');

    const patched = await updateProject(
      req('PATCH', `/projects/${created.projectId}`, {
        token,
        params: { id: created.projectId },
        body: { name: 'Loan research v2' },
      }),
    );
    const next = (patched.body as { project: ProjectRecord }).project;
    expect(next.name).toBe('Loan research v2');
    expect(next.instructions).toBe('Always answer in bullet points.'); // untouched fields kept

    await deleteProject(
      req('DELETE', `/projects/${created.projectId}`, { token, params: { id: created.projectId } }),
    );
    const after = await listProjects(req('GET', '/projects', { token }));
    expect((after.body as { projects: ProjectRecord[] }).projects).toHaveLength(0);
  });

  it('rejects an empty name and enforces the per-user limit', async () => {
    const token = await makeUser();
    await expect(
      createProject(req('POST', '/projects', { token, body: { name: '   ' } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    for (let i = 0; i < 20; i++) await makeProject(token, { name: `p${i}` });
    await expect(
      createProject(req('POST', '/projects', { token, body: { name: 'one too many' } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it("returns IDOR-safe 404s for another user's project", async () => {
    const tokenA = await makeUser();
    const tokenB = await makeUser();
    const project = await makeProject(tokenA, { name: 'private' });

    await expect(
      updateProject(
        req('PATCH', `/projects/${project.projectId}`, {
          token: tokenB,
          params: { id: project.projectId },
          body: { name: 'stolen' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      deleteProject(
        req('DELETE', `/projects/${project.projectId}`, { token: tokenB, params: { id: project.projectId } }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('chatting inside a project', () => {
  it('stamps the new conversation with the project and injects its instructions', async () => {
    const { llm, requests } = recordingLlm();
    setLlm(llm);
    const token = await makeUser();
    const project = await makeProject(token, {
      name: 'Loan research',
      description: 'Pricing work',
      instructions: 'Always answer in bullet points.',
    });

    const events = await sendChat(token, { message: 'hello', projectId: project.projectId });
    const convId = routingOf(events).conversationId;

    const convs = await listConvs(token);
    expect(convs.find((c) => c.convId === convId)?.projectId).toBe(project.projectId);

    // The agent turn (not the forced router call) carries the project context.
    const agentTurn = requests.find((r) => !r.forceTool);
    expect(agentTurn?.system).toContain('Loan research');
    expect(agentTurn?.system).toContain('Always answer in bullet points.');

    // Follow-up messages to the existing conversation keep the injection.
    requests.length = 0;
    await sendChat(token, { conversationId: convId, message: 'and again' });
    expect(requests.find((r) => !r.forceTool)?.system).toContain('Always answer in bullet points.');
  });

  it("rejects starting a chat in another user's (or unknown) project", async () => {
    const tokenA = await makeUser();
    const tokenB = await makeUser();
    const project = await makeProject(tokenA, { name: 'private' });

    await expect(
      sendChat(tokenB, { message: 'hi', projectId: project.projectId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('moving conversations and deleting projects', () => {
  it('moves a chat into a project and detaches it with projectId: null', async () => {
    const token = await makeUser();
    const project = await makeProject(token, { name: 'bucket' });
    const events = await sendChat(token, { message: 'ungrouped chat' });
    const convId = routingOf(events).conversationId;

    await updateConversation(
      req('PATCH', `/conversations/${convId}`, {
        token,
        params: { id: convId },
        body: { projectId: project.projectId },
      }),
    );
    expect((await listConvs(token)).find((c) => c.convId === convId)?.projectId).toBe(project.projectId);

    await updateConversation(
      req('PATCH', `/conversations/${convId}`, { token, params: { id: convId }, body: { projectId: null } }),
    );
    expect((await listConvs(token)).find((c) => c.convId === convId)?.projectId).toBeUndefined();
  });

  it('rejects moving a chat into a project the user does not own', async () => {
    const tokenA = await makeUser();
    const tokenB = await makeUser();
    const foreign = await makeProject(tokenB, { name: 'not yours' });
    const events = await sendChat(tokenA, { message: 'my chat' });
    const convId = routingOf(events).conversationId;

    await expect(
      updateConversation(
        req('PATCH', `/conversations/${convId}`, {
          token: tokenA,
          params: { id: convId },
          body: { projectId: foreign.projectId },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('deleting a project keeps its chats and detaches them', async () => {
    const token = await makeUser();
    const project = await makeProject(token, { name: 'doomed' });
    const events = await sendChat(token, { message: 'chat inside', projectId: project.projectId });
    const convId = routingOf(events).conversationId;

    await deleteProject(
      req('DELETE', `/projects/${project.projectId}`, { token, params: { id: project.projectId } }),
    );

    const convs = await listConvs(token);
    const conv = convs.find((c) => c.convId === convId);
    expect(conv).toBeTruthy(); // the chat survives
    expect(conv?.projectId).toBeUndefined(); // but is detached
  });
});
