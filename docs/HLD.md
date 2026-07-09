# High-Level Design - AI-Powered Assistant Platform

> Cross River take-home assignment. Multi-agent assistant platform: a routing agent
> delegates authenticated user requests to specialized agents (Generic, Coding,
> Financial Advisor), streaming responses in real time through a serverless AWS
> architecture.

---

## 1. Goals & Non-Goals

### Goals
- **G1** - Secure JWT auth (email/password, access + refresh tokens); all agent services gated behind auth.
- **G2** - Modular router agent: LLM-based intent classification delegates to specialized agents; adding an agent is a one-file change.
- **G3** - External tools: Web Search and a sandboxed Code Interpreter, wired into agents via a uniform tool interface.
- **G4** - True token-by-token streaming from Bedrock → backend → browser (SSE).
- **G5** - Serverless-shaped architecture: Lambda handlers + DynamoDB + Bedrock, runnable **locally first** and deployable with one command (IaC included).
- **G6** - Responsive Next.js UI following the Milgo design system (flat surfaces, hairline borders, navy + turquoise).

### Non-Goals
- Multi-region HA, rate-limit billing tiers, admin tooling, agent-to-agent collaboration (noted as future work in §9).
- OAuth / social login (brief specifies email + password).

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                  BROWSER                                     │
│   Next.js (App Router) SPA - login, chat, streaming renderer, session mgmt   │
└──────────────┬───────────────────────────────────────────────┬───────────────┘
               │  HTTPS JSON (auth, history)                   │  SSE (chat stream)
               ▼                                               ▼
┌──────────────────────────────┐            ┌──────────────────────────────────┐
│   Auth API                   │            │   Chat API (streaming)           │
│   Lambda: /auth/signup       │            │   Lambda Function URL            │
│   Lambda: /auth/login        │            │   (RESPONSE_STREAM mode)         │
│   Lambda: /auth/refresh      │            │   POST /chat  → SSE              │
└──────────┬───────────────────┘            └────────┬─────────────────────────┘
           │                                         │ verify JWT
           │ bcrypt / JWT sign                       ▼
           │                                ┌─────────────────────────────────┐
           │                                │        ROUTER AGENT             │
           │                                │  1. classify intent (Haiku)     │
           │                                │  2. keyword fallback            │
           │                                │  3. delegate to agent           │
           │                                └───┬─────────┬─────────┬─────────┘
           │                                    ▼         ▼         ▼
           │                            ┌─────────┐ ┌─────────┐ ┌────────────┐
           │                            │ Generic │ │ Coding  │ │ Financial  │
           │                            │ Agent   │ │ Agent   │ │ Advisor    │
           │                            └────┬────┘ └────┬────┘ └─────┬──────┘
           │                                 │           │            │
           │                                 ▼           ▼            ▼
           │                            ┌────────────────────────────────────┐
           │                            │              TOOLS                 │
           │                            │  • Web Search (Tavily API)         │
           │                            │  • Code Interpreter (sandboxed VM) │
           │                            └────────────────────────────────────┘
           │                                         │
           ▼                                         ▼
┌──────────────────────────┐            ┌─────────────────────────────────────┐
│  DynamoDB (single table) │            │  AWS Bedrock                        │
│  users / refresh tokens /│            │  • Claude Haiku  → routing          │
│  conversations / messages│            │  • Claude Sonnet → agent responses  │
└──────────────────────────┘            │  InvokeModelWithResponseStream      │
                                        └─────────────────────────────────────┘
```

### Runtime modes (same code, two wirings)

| Concern            | Local dev                                   | AWS deployed                          |
|--------------------|---------------------------------------------|---------------------------------------|
| HTTP entry         | Express adapter wrapping Lambda handlers    | API Gateway (auth) + Lambda Function URL (chat) |
| Streaming          | Express `res.write()` SSE                   | Lambda response streaming (`awslambda.streamifyResponse`) → SSE |
| Storage            | DynamoDB Local (Docker) or in-memory repo   | DynamoDB                              |
| LLM                | Bedrock via AWS SDK (real) or mock adapter  | Bedrock                               |
| IaC                | -                                           | AWS SAM template (`sam deploy`)       |

The Lambda handlers are the single source of truth; the Express server is a thin
adapter (`local/server.ts`) that converts req/res to Lambda events. Nothing is
forked between environments.

---

## 3. Component Responsibilities

### 3.1 Frontend (Next.js, App Router)
- **Login / signup page** - email + password; stores access token in memory, refresh token in `httpOnly`-style handling (see LLD §7 for the trade-off actually implemented).
- **Chat page** - conversation list, message thread, streaming renderer (agent badge pill shows which agent answered, tool-call chips show tool activity).
- **Session management** - silent refresh on 401, auto-logout on refresh failure.
- **Design system** - Milgo tokens ported LTR: `--primary: #071b35`, `--accent: #0cccda`, `--line: #eaeaea`, 6px radius, Google Sans/Inter, flat cards, pill statuses.

### 3.2 Auth service (Lambda)
- `POST /auth/signup` - bcrypt-hash password, create user in DynamoDB.
- `POST /auth/login` - verify credentials, return access JWT (15 min) + refresh token (7 days, rotated).
- `POST /auth/refresh` - rotate refresh token, issue new access JWT.
- `POST /auth/logout` - revoke the refresh-token family (server-side sign-out).
- Access JWT is verified in the chat Lambda (shared `verifyToken` middleware) - **stateless** authorization; only refresh tokens hit the DB.

### 3.3 Router agent
- **Primary**: one cheap/fast Bedrock call (Claude Haiku) with a constrained JSON schema → `{ agent: "generic" | "coding" | "financial", confidence }`.
- **Fallback**: if the classifier call fails or times out (2s), a keyword heuristic routes; if that is ambiguous → `generic`.
- Emits a `routing` SSE event before the answer stream so the UI can show "→ Coding Agent" immediately.

### 3.4 Specialized agents
All agents implement one interface (`Agent`: `name`, `description`, `systemPrompt`, `tools[]`, `model`). The registry is a map - **adding an agent = adding one file + one registry entry** (G2).

| Agent | Model | Tools | Notes |
|---|---|---|---|
| Generic | Claude Sonnet | Web Search | default fallback route |
| Coding | Claude Sonnet | Code Interpreter | can execute JS to verify its own snippets |
| Financial Advisor | Claude Sonnet | Web Search | system prompt includes advice disclaimer |

### 3.5 Tools
Uniform `Tool` interface (`name`, `description`, `inputSchema`, `execute()`), exposed to Bedrock via its native tool-use API. The agent loop: stream model output → on `tool_use` block, pause, execute tool, emit `tool` SSE events, continue with `tool_result`.

- **Web Search** - Tavily API (free tier); returns top-N snippets + URLs.
- **Code Interpreter** - JS execution in an isolated child process (no fs/net, 5s timeout, output capped); result fed back to the model.

### 3.6 Storage (DynamoDB single-table)
One table, generic `PK`/`SK`. Entities: User, RefreshToken, Conversation, Message. Full key design and access patterns in LLD §5.

---

## 4. Key Flows

### 4.1 Auth flow
1. User submits email/password → `POST /auth/login`.
2. Lambda loads user by email (GSI), `bcrypt.compare`, on success signs access JWT (15 min, `sub`, `email`) and creates a rotated refresh token record in DynamoDB (7-day TTL).
3. Client keeps the access token in memory; refresh token persisted client-side (LLD §7).
4. Any 401 from the chat API → client calls `/auth/refresh` once, retries; if refresh fails → logout.

### 4.2 Chat streaming flow (the critical path)
1. `POST /chat` (SSE) with `{ conversationId?, message }` + `Authorization: Bearer <jwt>`.
2. Lambda verifies JWT **before** doing anything else; invalid → `401` (JSON, not SSE).
3. Load last N messages of the conversation from DynamoDB for context.
4. **Router**: Haiku classify (2s timeout) → emit `event: routing` with the chosen agent.
5. **Agent loop**: Bedrock `InvokeModelWithResponseStream` with the agent's system prompt, history, and tool definitions.
   - text deltas → `event: token`
   - tool use → `event: tool_start` / `event: tool_result`, then continue the model turn
6. On completion → `event: done` with usage metadata; persist both messages to DynamoDB.
7. On any mid-stream failure → `event: error` with a safe message + error code, stream closed cleanly (never a dangling connection).

### 4.3 Error handling strategy (G4 robustness)
- **Taxonomy**: `AUTH_*`, `ROUTING_*`, `AGENT_*`, `TOOL_*`, `STORAGE_*` - every layer throws typed errors; one boundary translates them to HTTP status or SSE `error` events. Internals are logged, never leaked to the client.
- **Mid-stream errors** are the interesting case: HTTP status is already 200, so errors travel *in-band* as `event: error` and the UI renders an inline error card in the thread.
- **Degradation ladder**: router LLM fails → keyword fallback → generic agent. Tool fails → tool_result carries the error and the model answers without it. Bedrock stream fails after partial output → partial text is kept, error event appended.

---

## 5. Security Considerations
- Passwords: bcrypt (cost 10), never logged.
- JWT: HS256, short-lived access (15 min); refresh rotation with reuse detection (a reused rotated token revokes the family).
- All `/chat` and `/conversations` routes require a valid access token; verification happens in-handler (no unauthenticated Bedrock spend).
- Code Interpreter: isolated child process, no `require`, no network, no filesystem, hard 5s kill, 64KB output cap.
- Secrets via env (`.env` locally, Lambda env/SSM deployed). No secrets in the repo.
- Input caps: message length, history window, tool-loop max iterations (guards cost + prompt injection blast radius).
- **Ownership checks (IDOR)**: every conversation/message read is keyed by the JWT's `sub` - a valid token for user A can never read user B's conversation.
- **Rate limiting**: per-user token bucket on `/chat` (10 msg/min) and a stricter per-IP bucket on `/auth/*` (brute-force protection).
- **User enumeration**: login returns one generic error for unknown-email and wrong-password; bcrypt runs against a dummy hash when the user doesn't exist (timing equalization).
- **XSS**: assistant markdown is sanitized (`rehype-sanitize`) before rendering; no raw HTML injection path.
- **Prompt injection via tools**: search results are wrapped in data delimiters and framed as untrusted content; tools can't be invoked more than `MAX_TOOL_TURNS` times per message.
- **Transport/API**: CORS allowlist (frontend origin only), JSON body size limit (32KB), validation (zod) on every input.

## 6. Scalability Notes
- Stateless Lambdas + stateless JWT verification → horizontal scale is free.
- DynamoDB on-demand capacity; single-table keys chosen so every access pattern is a `Query`, no `Scan`s.
- Router uses Haiku (cheap, ~300ms) so routing adds negligible latency/cost per message.
- Streaming Lambda is long-lived per request (up to model completion); Function URL streaming supports up to 15-min invocations - fine for chat.

## 7. Technology Decisions (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Backend | Node.js 20 + TypeScript | Assignment preference; typed `Agent`/`Tool` interfaces make modularity explicit |
| Streaming transport | SSE over Lambda response streaming | HTTP-native, identical locally (Express) and deployed; WebSockets add a connection table + more infra for no benefit in a one-way stream |
| Routing | LLM classifier (Haiku) + keyword fallback | Real-world pattern: cheap model routes, capable model answers; fallback keeps the system up if routing model fails |
| Storage | DynamoDB single-table | Assignment stack; demonstrates access-pattern-first modeling |
| Auth | Custom JWT + refresh rotation | Brief explicitly asks for JWT email/password (Cognito would hide the interesting work) |
| Frontend | Next.js App Router | Modern default; pure client of the API (no Next server-side agent calls, keeps backend serverless story clean) |
| IaC | AWS SAM | Lightest-weight way to declare Lambdas + DynamoDB + Function URL streaming |
| Tests | Vitest | Fast, TS-native; unit tests target router, auth, tools, storage mapping |

## 8. Deliverables Mapping

| Assignment requirement | Where satisfied |
|---|---|
| JWT auth, email/password, gated agents | Auth Lambdas + `verifyToken` in chat handler |
| Modular router + 3 agents, easy to extend | `agents/registry.ts` (§3.3-3.4, LLD §4) |
| External tools | Web Search + Code Interpreter (§3.5) |
| Streaming + robust errors | SSE pipeline + error taxonomy (§4.2-4.3) |
| Responsive UI, login, live streaming | Next.js app, Milgo design system |
| AWS Bedrock / Lambda / DynamoDB | §2 runtime table + SAM template |
| Unit tests | Vitest suites (LLD §10) |
| README + video | README.md walkthrough; demo script in README |

## 9. Future Work
- Conversation titles via async summarization; message search.
- Agent memory / user profile injection.
- WebSocket upgrade if bi-directional interaction (mid-stream cancel already works via `AbortController` + connection close).
- Cognito or refresh-token httpOnly cookies behind CloudFront for production-grade session security.
