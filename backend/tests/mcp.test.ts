import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signup } from '../src/handlers/auth';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  updateMcpServer,
} from '../src/handlers/mcp';
import type { ApiRequest } from '../src/handlers/http';
import { buildMcpTools, mcpToolName } from '../src/mcp/tools';
import type { McpServerRecord } from '../src/store/types';
import { createMemoryStore } from '../src/store/memory';
import { setStore } from '../src/store/index';

/**
 * The MCP network layer is mocked: probeMcpServer/connectMcp answer from a
 * fake server so handler + tool-adapter logic is tested without sockets.
 * assertAllowedMcpUrl stays real (URL validation is part of the contract).
 */
vi.mock('../src/mcp/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/mcp/client')>();
  return {
    ...original,
    probeMcpServer: vi.fn(async (url: string) =>
      url.includes('broken')
        ? { ok: false as const, error: 'connection refused' }
        : {
            ok: true as const,
            tools: [{ name: 'get_weather', description: 'Weather lookup', inputSchema: { type: 'object' } }],
          },
    ),
    connectMcp: vi.fn(async () => ({
      listTools: async () => [],
      callTool: async (name: string) => `result of ${name}`,
      close: async () => undefined,
    })),
  };
});

let ipCounter = 200;

async function makeUser(): Promise<string> {
  const res = await signup(mkReq('POST', '/auth/signup', {
    body: { email: `mcp${++ipCounter}@test.com`, password: 'password123' },
    ip: `10.3.0.${ipCounter % 250}`,
  }));
  return (res.body as { accessToken: string }).accessToken;
}

function mkReq(method: string, path: string, extra: Partial<ApiRequest> & { token?: string } = {}): ApiRequest {
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

beforeEach(() => {
  setStore(createMemoryStore());
});

describe('MCP tool naming', () => {
  it('namespaces and sanitizes to the strictest provider charset', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp_github_create_issue');
    expect(mcpToolName('My Server!', 'tool.name')).toBe('mcp_My_Server__tool_name');
    expect(mcpToolName('x'.repeat(40), 'y'.repeat(80)).length).toBeLessThanOrEqual(64);
    expect(mcpToolName('github', 'search')).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
  });
});

describe('MCP connector CRUD', () => {
  it('probes on create, snapshots tools, and never echoes the auth token', async () => {
    const token = await makeUser();
    const created = await createMcpServer(
      mkReq('POST', '/mcp/servers', {
        token,
        body: { name: 'weather', url: 'https://mcp.example.com/mcp', authToken: 'sk-secret-token' },
      }),
    );
    expect(created.status).toBe(201);
    const server = (created.body as { server: Record<string, unknown> }).server;
    expect(server.status).toBe('ok');
    expect(server.enabled).toBe(true);
    expect(server.hasAuth).toBe(true);
    expect((server.tools as Array<{ name: string }>)[0]!.name).toBe('get_weather');
    expect(JSON.stringify(created.body)).not.toContain('sk-secret-token');

    const listed = await listMcpServers(mkReq('GET', '/mcp/servers', { token }));
    expect(JSON.stringify(listed.body)).not.toContain('sk-secret-token');
  });

  it('marks unreachable servers as error and keeps them disabled', async () => {
    const token = await makeUser();
    const created = await createMcpServer(
      mkReq('POST', '/mcp/servers', { token, body: { name: 'bad', url: 'https://broken.example.com/mcp' } }),
    );
    const server = (created.body as { server: { status: string; enabled: boolean; lastError?: string } }).server;
    expect(server.status).toBe('error');
    expect(server.enabled).toBe(false);
    expect(server.lastError).toContain('connection refused');
  });

  it('rejects non-http(s) URLs outright', async () => {
    const token = await makeUser();
    await expect(
      createMcpServer(mkReq('POST', '/mcp/servers', { token, body: { name: 'f', url: 'file:///etc/passwd' } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('toggles, and deletes with IDOR-safe 404s', async () => {
    const tokenA = await makeUser();
    const tokenB = await makeUser();
    const created = await createMcpServer(
      mkReq('POST', '/mcp/servers', { token: tokenA, body: { name: 'weather', url: 'https://mcp.example.com/mcp' } }),
    );
    const id = (created.body as { server: { serverId: string } }).server.serverId;

    await expect(
      updateMcpServer(mkReq('PATCH', `/mcp/servers/${id}`, { token: tokenB, params: { id }, body: { enabled: false } })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const toggled = await updateMcpServer(
      mkReq('PATCH', `/mcp/servers/${id}`, { token: tokenA, params: { id }, body: { enabled: false } }),
    );
    expect((toggled.body as { server: { enabled: boolean } }).server.enabled).toBe(false);

    await deleteMcpServer(mkReq('DELETE', `/mcp/servers/${id}`, { token: tokenA, params: { id } }));
    const listed = await listMcpServers(mkReq('GET', '/mcp/servers', { token: tokenA }));
    expect((listed.body as { servers: unknown[] }).servers).toHaveLength(0);
  });
});

describe('MCP tools in the agent loop', () => {
  const record = (over: Partial<McpServerRecord> = {}): McpServerRecord => ({
    serverId: 's1',
    userId: 'u1',
    name: 'github',
    url: 'https://mcp.example.com/mcp',
    enabled: true,
    tools: [{ name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object' } }],
    status: 'ok',
    createdAt: '2026-01-01T00:00:00Z',
    lastCheckedAt: '2026-01-01T00:00:00Z',
    ...over,
  });

  it('exposes enabled servers as namespaced tools with untrusted-data framing', async () => {
    const tools = buildMcpTools([record()]);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('mcp_github_create_issue');
    expect(tools[0]!.description).toContain('[MCP connector "github"]');

    const result = await tools[0]!.execute({ title: 'bug' }, {
      userId: 'u1',
      conversationId: 'c1',
      history: [],
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('<mcp_result server="github" tool="create_issue">');
    expect(result.content).toContain('Untrusted connector output');
    expect(result.content).toContain('result of create_issue');
  });

  it('skips disabled and errored servers', () => {
    expect(buildMcpTools([record({ enabled: false })])).toHaveLength(0);
    expect(buildMcpTools([record({ status: 'error' })])).toHaveLength(0);
  });

  it('de-duplicates tool names that sanitize to the same string', () => {
    // "tool.name" and "tool name" both sanitize to mcp_github_tool_name;
    // the second must be suffixed so no two tools collide in the agent loop.
    const tools = buildMcpTools([
      record({
        tools: [
          { name: 'tool.name', description: 'a', inputSchema: { type: 'object' } },
          { name: 'tool name', description: 'b', inputSchema: { type: 'object' } },
        ],
      }),
    ]);
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe('mcp_github_tool_name');
    expect(names[1]).toBe('mcp_github_tool_name_2');
  });
});
