import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../core/config';
import { AppError } from '../core/errors';
import type { McpToolInfo } from '../store/types';

/**
 * Minimal MCP client for user-connected servers (docs/LLD.md §15).
 *
 * - Transport: Streamable HTTP first, legacy SSE as fallback - covers both
 *   generations of remote MCP servers.
 * - Lifecycle: connect → do one thing → close. Stateless per call, so it works
 *   identically under Express and per-invocation Lambda.
 * - The URL is user-supplied → SSRF surface. Private/loopback hosts are
 *   rejected unless MCP_ALLOW_LOCAL=true (dev default; false when deployed).
 *   DNS-rebinding-grade protection is out of scope and documented.
 */

export interface McpConnection {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

const PRIVATE_HOST =
  /^(localhost|.*\.local|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|169\.254(\.\d{1,3}){2}|0\.0\.0\.0|\[?::1\]?)$/i;

export function assertAllowedMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'MCP server URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('VALIDATION_FAILED', 400, 'MCP server URL must be http(s)');
  }
  if (!config.mcpAllowLocal && PRIVATE_HOST.test(url.hostname)) {
    throw new AppError('VALIDATION_FAILED', 400, 'MCP server URL points to a private address');
  }
  return url;
}

function withTimeout<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/** Flatten a tools/call result into text the model can consume. */
function resultToText(result: unknown): string {
  const content = (result as { content?: Array<Record<string, unknown>> }).content ?? [];
  const parts = content.map((c) =>
    c.type === 'text' ? String(c.text ?? '')
    : c.type === 'image' ? '[image result omitted]'
    : c.type === 'resource' ? '[resource result omitted]'
    : `[${String(c.type)} result]`,
  );
  const text = parts.join('\n').trim() || '(empty result)';
  return text.slice(0, 4_000);
}

export async function connectMcp(url: string, authToken?: string): Promise<McpConnection> {
  const target = assertAllowedMcpUrl(url);
  const requestInit: RequestInit | undefined = authToken
    ? { headers: { authorization: `Bearer ${authToken}` } }
    : undefined;

  const client = new Client({ name: 'crossriver-assistant', version: '1.0.0' });

  // Streamable HTTP is the current spec transport; older servers only speak
  // HTTP+SSE. Try modern first, fall back once (the SDK-recommended pattern).
  try {
    await withTimeout(
      config.mcpConnectTimeoutMs,
      client.connect(new StreamableHTTPClientTransport(target, { requestInit })),
      'MCP connect',
    );
  } catch {
    await withTimeout(
      config.mcpConnectTimeoutMs,
      client.connect(new SSEClientTransport(target, { requestInit })),
      'MCP connect (SSE fallback)',
    );
  }

  return {
    async listTools() {
      const res = await withTimeout(config.mcpConnectTimeoutMs, client.listTools(), 'MCP tools/list');
      return res.tools.map((t) => ({
        name: t.name,
        description: (t.description ?? '').slice(0, 500),
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      }));
    },
    async callTool(name, args) {
      const res = await withTimeout(
        config.mcpCallTimeoutMs,
        client.callTool({ name, arguments: args }),
        `MCP tool ${name}`,
      );
      return resultToText(res);
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

/** Connect, list tools, close - used when a server is added or refreshed. */
export async function probeMcpServer(
  url: string,
  authToken?: string,
): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }> {
  try {
    const conn = await connectMcp(url, authToken);
    try {
      return { ok: true, tools: await conn.listTools() };
    } finally {
      await conn.close();
    }
  } catch (err) {
    if (err instanceof AppError) throw err; // URL validation belongs to the caller
    const message = err instanceof Error ? err.message : 'connection failed';
    return { ok: false, error: message.slice(0, 300) };
  }
}
