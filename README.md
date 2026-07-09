# AI-Powered Assistant Platform

A modular multi-agent assistant: a **router agent** classifies each request and
delegates it to a specialized agent (**Generic**, **Coding**, or **Financial
Advisor**), which can call external tools (**web search**, **sandboxed code
interpreter**, **user-connected MCP servers**) and streams its answer
token-by-token to a React UI behind JWT authentication.

Built for the Cross River take-home assignment.

| | |
|---|---|
| Backend | Node.js 20 + TypeScript, Lambda-shaped handlers (Express adapter locally, AWS SAM deployed) |
| Frontend | Next.js 14 (App Router), design system ported from an internal Resend-style system |
| AI | AWS Bedrock or the Anthropic API (Claude Haiku routes, Claude Sonnet answers) - or a zero-credential mock |
| Storage | DynamoDB single-table (DynamoDB Local or AWS) - or in-memory |
| Streaming | SSE over Lambda response streaming / Express |
| Tests | 137 unit tests (82 backend + 55 frontend), Vitest |

**Product features:** token streaming with stop/partial-keep · edit-and-branch +
regenerate with sibling navigation · searchable, renamable, deletable history ·
GFM/LaTeX/syntax-highlighted markdown with copy buttons · cross-session memory
with a visible "Memory updated" chip and full user control · custom
instructions/personas · artifacts side-panel for code · image + text-file
attachments (paste screenshots) and voice dictation · **user-connected MCP
servers** whose tools all agents can call · thumbs feedback with comments ·
incognito chats, memory toggle, delete-all controls · customizable keyboard shortcuts ·
live pipeline transparency panel.

Design docs: [docs/HLD.md](docs/HLD.md) · [docs/LLD.md](docs/LLD.md) · [docs/COST.md](docs/COST.md)

---

## Quick start (zero credentials)

Runs with a deterministic mock LLM and in-memory storage - no AWS account needed.

```bash
make install   # installs backend + frontend dependencies
make dev       # backend :4000 + frontend :3000 together (Ctrl-C stops both)
```

`make help` lists everything else - `make test` (all 137 tests), `make check`
(typecheck + tests), `make db-up` (DynamoDB Local + table), `make deploy` (SAM).
Prefer npm directly? Each package still works standalone: `cd backend && npm run dev`
and `cd frontend && npm run dev`.

Open http://localhost:3000, create an account, and chat. Try:
- *"help me debug this javascript function"* → routed to the **Coding Agent**
- *"should I invest in index funds"* → routed to the **Financial Advisor**
- *"how do airplanes fly"* → routed to the **Generic Agent**

## Real stack (Bedrock + DynamoDB Local)

```bash
# DynamoDB Local
docker compose up -d
cd backend && npm run create-table

# backend/.env  (cp .env.example .env)
LLM_PROVIDER=bedrock        # needs AWS credentials with Bedrock model access
STORE=dynamo
DYNAMO_ENDPOINT=http://localhost:8000
TAVILY_API_KEY=tvly-...     # optional: enables real web search

npm run dev
```

## Deploy to AWS

```bash
cd backend
sam build && sam deploy --guided    # prompts for JwtSecret, FrontendOrigin, TavilyApiKey
```

Provisions: DynamoDB table (+ GSI, TTL), auth/conversation Lambdas behind an
HTTP API, and the chat Lambda on a **Function URL in RESPONSE_STREAM mode**
(API Gateway cannot stream). Point the frontend at the outputs:
`NEXT_PUBLIC_API_URL` (API) and `NEXT_PUBLIC_CHAT_URL` (Function URL).

## Configuration (environment variables)

Every variable has a safe local default (all are optional - the app boots with
zero configuration). Backend vars live in `backend/.env`
(`cp .env.example .env`), frontend vars in `frontend/.env.local`. The single
source of truth is [backend/src/core/config.ts](backend/src/core/config.ts).

### Backend - core

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `mock` (deterministic, no credentials), `anthropic`, or `bedrock` |
| `JWT_SECRET` | `dev-secret-change-me` | Signs access tokens - **set a real value in production** |
| `STORE` | `memory` | `memory` (in-process) or `dynamo` (DynamoDB Local or AWS) |
| `PORT` | `4000` | Local Express port |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | CORS allow-origin for the UI |

### Backend - LLM provider

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | - | Required when `LLM_PROVIDER=anthropic` |
| `ANTHROPIC_ROUTER_MODEL` | `claude-haiku-4-5` | Classifier model (Anthropic API) |
| `ANTHROPIC_AGENT_MODEL` | `claude-sonnet-4-5` | Answering model (Anthropic API) |
| `AWS_REGION` | `us-east-1` | Bedrock + DynamoDB region |
| `BEDROCK_ROUTER_MODEL` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Classifier model (Bedrock inference profile) |
| `BEDROCK_AGENT_MODEL` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Answering model (Bedrock inference profile) |

`LLM_PROVIDER=bedrock` needs AWS credentials with Bedrock model access in the
environment (profile, SSO, or instance role) - there is no key variable for it.

### Backend - storage & tools

| Variable | Default | Purpose |
|---|---|---|
| `DYNAMO_TABLE` | `assistant-platform` | Table name when `STORE=dynamo` |
| `DYNAMO_ENDPOINT` | - | Set to `http://localhost:8000` for DynamoDB Local; leave unset on AWS |
| `TAVILY_API_KEY` | - | Enables real web search; without it the `web_search` tool reports "search unavailable" and the agent answers from its own knowledge |

### Backend - tuning & safety (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `ROUTER_TIMEOUT_MS` | `2000` | LLM classification budget before keyword fallback |
| `CODE_TIMEOUT_MS` | `5000` | Sandboxed code-interpreter wall clock |
| `MEMORY_EXTRACT_TIMEOUT_MS` | `4000` | Post-answer memory-extraction budget (best-effort) |
| `CHAT_RATE_PER_DAY` | `200` | Per-user daily chat cap (per-minute caps are fixed in code) |
| `BLOCKED_TOPICS` | *(empty)* | Comma-separated phrases rejected before any LLM call ([moderation.ts](backend/src/core/moderation.ts)) |
| `MCP_ALLOW_LOCAL` | `true` | Allow loopback/private MCP URLs - handy in dev, an SSRF vector in prod; [template.yaml](backend/template.yaml) pins it to `false` on AWS |
| `MCP_CONNECT_TIMEOUT_MS` | `8000` | MCP server connect timeout |
| `MCP_CALL_TIMEOUT_MS` | `20000` | MCP tool-call timeout |

### Frontend (`frontend/.env.local`)

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Backend API base URL |
| `NEXT_PUBLIC_CHAT_URL` | *(same as API URL)* | Streaming chat endpoint - set separately when deployed, since chat runs on a Lambda Function URL |

## Tests

```bash
cd backend && npm test      # 82 tests: router, auth, agent loop, sandbox, stores, chat e2e,
                            #           branching, memory, attachments, search, feedback, MCP
cd frontend && npm test     # 55 tests: SSE parser, session/refresh, pipeline reducers,
                            #           thread tree, artifact extraction, shortcut bindings
```

---

## Architecture

```
Browser (Next.js) ──JWT──▶ Auth API ──▶ DynamoDB (users, refresh tokens)
        │
        └──SSE──▶ Chat API ─▶ Router Agent (Haiku classify → keyword fallback)
                     │              ├─▶ Generic Agent ──▶ web_search
                     │              ├─▶ Coding Agent ──▶ code_interpreter
                     │              └─▶ Financial Agent ─▶ web_search
                     │         (Bedrock ConverseStream, tool-use loop ≤ 3 turns)
                     └─▶ DynamoDB (conversations, messages)
```

Key decisions (full rationale in [docs/HLD.md](docs/HLD.md)):

- **One handler codebase, two transports.** Handlers take a transport-neutral
  `ApiRequest`/`SseWriter`; Express (local) and Lambda wrappers (deployed) are
  thin adapters. Local behavior *is* deployed behavior.
- **Adding an agent is one file + one registry line**
  ([backend/src/agents/registry.ts](backend/src/agents/registry.ts)). The
  router's classifier prompt and its forced-tool enum are generated from the
  registry, so new agents route automatically.
- **Routing never fails.** LLM classification (2s timeout) → keyword heuristic
  → generic agent. The stream emits a `routing` event first so the UI shows the
  chosen agent immediately.
- **Errors are phase-aware.** Before streaming starts: plain HTTP errors
  (401/400/429). Mid-stream (status already 200): in-band `error` SSE events;
  partial output is persisted flagged `truncated`.
- **Security:** bcrypt + login timing equalization, 15-min JWTs, refresh
  rotation with reuse detection (family revocation), per-user/per-IP rate
  limits, IDOR-safe data keys (404 not 403), sanitized markdown rendering,
  sandboxed code execution with empty env. Threat table in
  [docs/LLD.md §10](docs/LLD.md).

## Project walkthrough

The fastest way to understand the codebase is to follow one chat message from
keystroke to rendered answer. Every step below links to the file that owns it.

**1. The user hits Send.**
[Composer.tsx](frontend/src/components/Composer.tsx) collects the text (plus any
pasted images/files and dictation) and the chat page hands it to `streamChat()`
in [sse.ts](frontend/src/lib/sse.ts), which POSTs to `/chat` with the JWT and
feeds the response body through `createSseParser()`. Auth state and silent
token refresh live in [auth-context.tsx](frontend/src/lib/auth-context.tsx).

**2. Pre-stream validation (plain HTTP errors).**
The backend entry point is `chat()` in
[chat.ts](backend/src/handlers/chat.ts) - reached through the Express adapter
locally ([server.ts](backend/src/local/server.ts)) or the Lambda streaming
adapter when deployed ([lambda.ts](backend/src/handlers/lambda.ts)); both wrap
the same transport-neutral handler. Before any bytes stream it verifies the
JWT, takes per-user rate-limit tokens
([rate-limit.ts](backend/src/core/rate-limit.ts)), validates the body with Zod,
and checks the topic blacklist ([moderation.ts](backend/src/core/moderation.ts)).
Failures here are ordinary 401/400/429 responses.

**3. The conversation thread is resolved.**
Messages form a tree, not a list - editing a message or regenerating an answer
creates a sibling branch. [thread.ts](backend/src/core/thread.ts) computes the
active path (`defaultPath`/`pathTo`) that becomes the LLM history. New
conversations are created on first message; ephemeral (incognito) chats skip
the store entirely and use client-supplied history.

**4. Personalization is assembled.**
User settings, project instructions, and saved memories are folded into a
system-prompt suffix, and the user's connected MCP servers are turned into
callable tools ([mcp/tools.ts](backend/src/mcp/tools.ts), speaking Streamable
HTTP with SSE fallback via [mcp/client.ts](backend/src/mcp/client.ts)).

**5. The router picks an agent.**
`route()` in [router.ts](backend/src/core/router.ts) asks Claude Haiku to
classify the message (2s timeout), falling back to keyword heuristics, falling
back to the generic agent - routing never fails. The choice comes from the
agent registry ([registry.ts](backend/src/agents/registry.ts)), which also
generates the classifier prompt, so adding an agent file + one registry line is
enough to make it routable. A `routing` SSE event is emitted immediately so the
UI can show the chosen agent before the first token.

**6. The agent loop runs.**
`runAgentTurn()` in [agent-loop.ts](backend/src/core/agent-loop.ts) streams
from the LLM ([llm/](backend/src/llm) - Bedrock, Anthropic, or the
deterministic mock) and executes tool calls for up to 3 turns: web search
([web-search.ts](backend/src/tools/web-search.ts)), the sandboxed code
interpreter ([code-interpreter.ts](backend/src/tools/code-interpreter.ts),
child process with empty env), or any MCP tool. Tokens, tool events, and
refusals are yielded as SSE events as they happen.

**7. Persistence and memory.**
The finished answer is stored under the correct tree parent and the
conversation is touched. If the stream dies midway, whatever text already
streamed is persisted flagged `truncated` - errors after the 200 travel in-band
as `error` events. After `done`,
[memory.ts](backend/src/core/memory.ts) extracts durable facts from the user's
message (best-effort) and emits a `memory` event that the UI surfaces as the
"Memory updated" chip.

**8. The UI renders the stream.**
The chat page ([chat/page.tsx](frontend/src/app/chat/page.tsx)) folds events
into the message tree ([thread.ts](frontend/src/lib/thread.ts)) and the live
pipeline view ([pipeline.ts](frontend/src/lib/pipeline.ts) →
[PipelinePanel.tsx](frontend/src/components/PipelinePanel.tsx)). Markdown is
sanitized and highlighted in [Markdown.tsx](frontend/src/components/Markdown.tsx),
and code blocks are lifted into the side panel via
[artifacts.ts](frontend/src/lib/artifacts.ts).

Auth itself is the one flow that never touches this path:
[handlers/auth.ts](backend/src/handlers/auth.ts) with bcrypt + timing
equalization ([passwords.ts](backend/src/auth/passwords.ts)) and refresh-token
rotation with reuse detection ([tokens.ts](backend/src/auth/tokens.ts)). All
persistence goes through one `Store` interface
([store/types.ts](backend/src/store/types.ts)) with in-memory and DynamoDB
single-table implementations - which is why the whole app runs with zero
credentials.

## Repository layout

```
docs/            HLD + LLD design documents
backend/
  src/handlers/  transport-neutral endpoints + Express/Lambda adapters
  src/core/      router, agent loop, thread branching, memory extraction, types, errors
  src/agents/    registry + generic/coding/financial agents
  src/tools/     web search, code-interpreter sandbox
  src/mcp/       MCP client (Streamable HTTP + SSE fallback) + tool adapter
  src/llm/       Bedrock/Anthropic stream adapters (text + image blocks) + mock
  src/auth/      bcrypt, JWT, refresh rotation
  src/store/     Store interface: memory + DynamoDB single-table
  tests/         82 Vitest tests
  template.yaml  AWS SAM (Lambdas, DynamoDB, streaming Function URL)
frontend/
  src/app/       login + chat pages (App Router)
  src/components/ Topbar, ConversationRail, MessageThread, Composer,
                  SettingsModal, ArtifactsPanel, PipelinePanel
  src/lib/       api, SSE parser, auth context, thread tree, artifacts
  tests/         55 Vitest tests
```
