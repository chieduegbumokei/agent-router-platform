import { beforeEach, describe, expect, it } from 'vitest';
import { listAgents } from '../src/handlers/agents';
import { signup } from '../src/handlers/auth';
import type { ApiRequest } from '../src/handlers/http';
import { createMemoryStore } from '../src/store/memory';
import { setStore } from '../src/store/index';

const req = (headers: Record<string, string> = {}): ApiRequest => ({
  method: 'GET',
  path: '/agents',
  params: {},
  query: {},
  headers,
  body: null,
  ip: '10.9.0.1',
});

beforeEach(() => setStore(createMemoryStore()));

describe('GET /agents', () => {
  it('requires authentication', async () => {
    await expect(listAgents(req())).rejects.toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
  });

  it('returns the registry with each agent and its tools', async () => {
    const s = await signup({
      method: 'POST',
      path: '/auth/signup',
      params: {},
      query: {},
      headers: {},
      body: { email: 'agents@test.com', password: 'password123' },
      ip: '10.9.0.2',
    });
    const { accessToken } = s.body as { accessToken: string };

    const res = await listAgents(req({ authorization: `Bearer ${accessToken}` }));
    expect(res.status).toBe(200);
    const { agents } = res.body as {
      agents: Array<{ id: string; displayName: string; tools: string[] }>;
    };
    expect(agents.map((a) => a.id).sort()).toEqual(['coding', 'financial', 'generic']);
    expect(agents.find((a) => a.id === 'coding')?.tools).toContain('code_interpreter');
    expect(agents.find((a) => a.id === 'generic')?.tools).toContain('web_search');
  });
});
