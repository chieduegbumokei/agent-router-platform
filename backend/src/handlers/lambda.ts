import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { toHttpError } from '../core/errors';
import type { StreamEvent } from '../core/types';
import { listAgents } from './agents';
import { login, logout, refresh, signup } from './auth';
import { chat } from './chat';
import {
  deleteAllConversations,
  deleteConversation,
  listConversations,
  listMessages,
  messageFeedback,
  searchConversations,
  updateConversation,
} from './conversations';
import { createProject, deleteProject, getProject, listProjects, updateProject } from './projects';
import { deleteAllMemories, deleteMemory, listMemories } from './memories';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  refreshMcpServer,
  updateMcpServer,
} from './mcp';
import { getSettings, updateSettings } from './settings';
import type { ApiRequest, ApiResponse, SseWriter } from './http';

/**
 * AWS entrypoints. Same transport-neutral handlers as local/server.ts -
 * API Gateway (HTTP API) fronts auth + conversations; the chat function uses a
 * Lambda Function URL in RESPONSE_STREAM mode for SSE.
 */

function toApiRequest(event: APIGatewayProxyEventV2): ApiRequest {
  return {
    method: event.requestContext.http.method,
    path: event.rawPath,
    params: (event.pathParameters ?? {}) as Record<string, string>,
    query: (event.queryStringParameters ?? {}) as Record<string, string | undefined>,
    headers: event.headers ?? {},
    body: event.body ? JSON.parse(event.body) : null,
    ip: event.requestContext.http.sourceIp ?? 'unknown',
  };
}

const respond = (out: ApiResponse): APIGatewayProxyResultV2 => ({
  statusCode: out.status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(out.body),
});

function wrap(handler: (r: ApiRequest) => Promise<ApiResponse>) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    try {
      return respond(await handler(toApiRequest(event)));
    } catch (err) {
      const { status, body } = toHttpError(err);
      return respond({ status, body });
    }
  };
}

// API Gateway routes → one Lambda each (see template.yaml)
export const signupHandler = wrap(signup);
export const loginHandler = wrap(login);
export const refreshHandler = wrap(refresh);
export const logoutHandler = wrap(logout);
export const listAgentsHandler = wrap(listAgents);
export const listConversationsHandler = wrap(listConversations);
export const listMessagesHandler = wrap(listMessages);

/**
 * The user-data plane (search, rename/delete, feedback, settings, memory,
 * MCP connectors) is one Lambda dispatching on the HTTP API routeKey - 15
 * single-route functions would be pure template sprawl with identical code.
 */
const userDataRoutes: Record<string, (r: ApiRequest) => Promise<ApiResponse>> = {
  'GET /conversations/search': searchConversations,
  'PATCH /conversations/{id}': updateConversation,
  'DELETE /conversations/{id}': deleteConversation,
  'DELETE /conversations': deleteAllConversations,
  'POST /conversations/{id}/messages/{msgId}/feedback': messageFeedback,
  'GET /projects': listProjects,
  'POST /projects': createProject,
  'GET /projects/{id}': getProject,
  'PATCH /projects/{id}': updateProject,
  'DELETE /projects/{id}': deleteProject,
  'GET /settings': getSettings,
  'PATCH /settings': updateSettings,
  'GET /memories': listMemories,
  'DELETE /memories/{id}': deleteMemory,
  'DELETE /memories': deleteAllMemories,
  'GET /mcp/servers': listMcpServers,
  'POST /mcp/servers': createMcpServer,
  'POST /mcp/servers/{id}/refresh': refreshMcpServer,
  'PATCH /mcp/servers/{id}': updateMcpServer,
  'DELETE /mcp/servers/{id}': deleteMcpServer,
};

export const userDataHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const handler = userDataRoutes[event.routeKey];
  if (!handler) {
    return respond({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Route not found' } } });
  }
  return wrap(handler)(event);
};

// ---------------------------------------------------------------------------
// Streaming chat - Lambda Function URL with response streaming.
// `awslambda` is a global injected by the Lambda Node.js runtime.
// ---------------------------------------------------------------------------

declare const awslambda: {
  streamifyResponse(
    fn: (event: APIGatewayProxyEventV2, responseStream: NodeJS.WritableStream & { setContentType?: (t: string) => void }) => Promise<void>,
  ): unknown;
  HttpResponseStream: {
    from(stream: NodeJS.WritableStream, metadata: { statusCode: number; headers: Record<string, string> }): NodeJS.WritableStream;
  };
};

export const chatHandler =
  typeof awslambda !== 'undefined'
    ? awslambda.streamifyResponse(async (event, responseStream) => {
        const req = toApiRequest(event);
        let stream: NodeJS.WritableStream | null = null;

        const open = (statusCode: number, contentType: string) => {
          stream = awslambda.HttpResponseStream.from(responseStream, {
            statusCode,
            headers: { 'content-type': contentType, 'cache-control': 'no-cache' },
          });
          return stream;
        };

        const abort = new AbortController();
        const sse: SseWriter = {
          write(e: StreamEvent) {
            if (!stream) open(200, 'text/event-stream');
            stream!.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          },
          close() {
            stream?.end();
          },
          signal: abort.signal,
        };

        try {
          await chat(req, sse);
          if (!stream) open(200, 'text/event-stream').end();
        } catch (err) {
          // pre-stream failure → JSON error response
          const { status, body } = toHttpError(err);
          if (!stream) {
            const s = open(status, 'application/json');
            s.write(JSON.stringify(body));
            s.end();
          } else {
            (stream as NodeJS.WritableStream).end();
          }
        }
      })
    : undefined;
