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
