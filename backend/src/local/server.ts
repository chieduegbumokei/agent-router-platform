import 'dotenv/config';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { config } from '../core/config';
import { toHttpError } from '../core/errors';
import type { StreamEvent } from '../core/types';
import { listAgents } from '../handlers/agents';
import { login, logout, refresh, signup } from '../handlers/auth';
import { chat } from '../handlers/chat';
import {
  deleteAllConversations,
  deleteConversation,
  listConversations,
  listMessages,
  messageFeedback,
  searchConversations,
  updateConversation,
} from '../handlers/conversations';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from '../handlers/projects';
import { deleteAllMemories, deleteMemory, listMemories } from '../handlers/memories';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  refreshMcpServer,
  updateMcpServer,
} from '../handlers/mcp';
import { getSettings, updateSettings } from '../handlers/settings';
import type { ApiRequest, ApiResponse, SseWriter } from '../handlers/http';

/**
 * Local dev adapter: Express is only a transport. Every route delegates to the
 * same transport-neutral handlers the Lambda wrappers use - nothing is forked
 * between local and deployed behavior.
 */
const app = express();

app.use(cors({ origin: config.frontendOrigin }));
// Parsers are attached per-route: chat carries base64 attachments (bounded by
// zod + the 6MB Lambda Function URL cap); everything else stays tiny.
const json = express.json({ limit: '32kb' });
const chatJson = express.json({ limit: '8mb' });

const toApiRequest = (req: Request): ApiRequest => ({
  method: req.method,
  path: req.path,
  params: req.params as Record<string, string>,
  query: req.query as Record<string, string | undefined>,
  headers: req.headers as Record<string, string | undefined>,
  body: req.body,
  ip: req.ip ?? 'unknown',
});

const wrap =
  (handler: (r: ApiRequest) => Promise<ApiResponse>) => async (req: Request, res: Response) => {
    try {
      const out = await handler(toApiRequest(req));
      res.status(out.status).json(out.body);
    } catch (err) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    }
  };

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/auth/signup', json, wrap(signup));
app.post('/auth/login', json, wrap(login));
app.post('/auth/refresh', json, wrap(refresh));
app.post('/auth/logout', json, wrap(logout));

app.get('/agents', json, wrap(listAgents));
app.get('/conversations', json, wrap(listConversations));
app.get('/conversations/search', json, wrap(searchConversations));
app.get('/conversations/:id/messages', json, wrap(listMessages));
app.patch('/conversations/:id', json, wrap(updateConversation));
app.delete('/conversations/:id', json, wrap(deleteConversation));
app.delete('/conversations', json, wrap(deleteAllConversations));
app.post('/conversations/:id/messages/:msgId/feedback', json, wrap(messageFeedback));

app.get('/projects', json, wrap(listProjects));
app.post('/projects', json, wrap(createProject));
app.get('/projects/:id', json, wrap(getProject));
app.patch('/projects/:id', json, wrap(updateProject));
app.delete('/projects/:id', json, wrap(deleteProject));

app.get('/settings', json, wrap(getSettings));
app.patch('/settings', json, wrap(updateSettings));

app.get('/memories', json, wrap(listMemories));
app.delete('/memories/:id', json, wrap(deleteMemory));
app.delete('/memories', json, wrap(deleteAllMemories));

app.get('/mcp/servers', json, wrap(listMcpServers));
app.post('/mcp/servers', json, wrap(createMcpServer));
app.post('/mcp/servers/:id/refresh', json, wrap(refreshMcpServer));
app.patch('/mcp/servers/:id', json, wrap(updateMcpServer));
app.delete('/mcp/servers/:id', json, wrap(deleteMcpServer));

app.post('/chat', chatJson, async (req: Request, res: Response) => {
  const abort = new AbortController();
  // res 'close' with an unfinished response = client disconnected mid-stream.
  // (req 'close' fires as soon as the request body is consumed - wrong signal.)
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  let streaming = false;
  const sse: SseWriter = {
    write(event: StreamEvent) {
      if (!streaming) {
        streaming = true;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
      }
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      if (streaming) res.end();
    },
    signal: abort.signal,
  };

  try {
    await chat(toApiRequest(req), sse);
    if (!streaming) res.status(200).end();
  } catch (err) {
    // Pre-stream failures (auth, validation, rate limit) → plain HTTP error.
    if (!streaming) {
      const { status, body } = toHttpError(err);
      res.status(status).json(body);
    } else {
      res.end();
    }
  }
});

/**
 * Dev convenience: the in-memory store resets on every restart, so seed a
 * known demo account (local server only - Lambda never runs this file).
 */
async function seedDemoUser(): Promise<void> {
  const { hashPassword } = await import('../auth/passwords');
  const { getStore } = await import('../store/index');
  const { newId } = await import('../core/ids');
  try {
    await getStore().createUser({
      userId: newId(),
      email: 'demo@crossriver.com',
      passwordHash: await hashPassword('password123'),
      createdAt: new Date().toISOString(),
    });
    // eslint-disable-next-line no-console
    console.log('demo user ready: demo@crossriver.com / password123');
  } catch {
    // already exists (persistent store) - fine
  }
}

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `assistant-platform backend on http://localhost:${config.port} ` +
      `(llm=${config.llmProvider}, store=${config.store})`,
  );
  void seedDemoUser();
});
