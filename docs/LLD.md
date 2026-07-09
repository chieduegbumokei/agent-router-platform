# Low-Level Design - AI-Powered Assistant Platform

> Companion to [HLD.md](HLD.md). This document specifies the repo layout, module
> contracts, data model, API surface, streaming protocol, and test plan in enough
> detail to implement directly.

---

## 1. Repository Layout

```
CrossRiver/
├── README.md                     # walkthrough + demo script
├── docs/
│   ├── HLD.md
│   └── LLD.md
├── backend/
│   ├── package.json              # workspaces root optional; kept simple: two packages
│   ├── tsconfig.json
│   ├── template.yaml             # AWS SAM - Lambdas, DynamoDB, Function URL
│   ├── src/
│   │   ├── handlers/             # Lambda entrypoints (thin: parse → service → respond)
│   │   │   ├── auth.ts           #   signup / login / refresh (API GW proxy handler)
│   │   │   ├── chat.ts           #   streaming chat (streamifyResponse)
│   │   │   └── conversations.ts  #   list conversations / get messages
│   │   ├── core/
│   │   │   ├── router.ts         # RouterAgent: classify + fallback + delegate
│   │   │   ├── agent-loop.ts     # Bedrock stream loop w/ tool-use handling
│   │   │   ├── types.ts          # Agent, Tool, StreamEvent, ChatContext
│   │   │   └── errors.ts         # AppError taxonomy + boundary translation
│   │   ├── agents/
│   │   │   ├── registry.ts       # AGENTS map - the single extension point
│   │   │   ├── generic.ts
│   │   │   ├── coding.ts
│   │   │   └── financial.ts
│   │   ├── tools/
│   │   │   ├── registry.ts
│   │   │   ├── web-search.ts     # Tavily
│   │   │   └── code-interpreter.ts
│   │   ├── llm/
│   │   │   ├── bedrock.ts        # ConverseStream wrapper (streaming + tool use)
│   │   │   └── mock.ts           # deterministic mock for tests / no-creds dev
│   │   ├── auth/
│   │   │   ├── tokens.ts         # sign/verify JWT, refresh rotation
│   │   │   └── passwords.ts      # bcrypt helpers
│   │   ├── store/
│   │   │   ├── client.ts         # DynamoDB DocumentClient (local endpoint switch)
│   │   │   ├── users.ts
│   │   │   ├── refresh-tokens.ts
│   │   │   └── conversations.ts
│   │   └── local/
│   │       └── server.ts         # Express adapter: routes → Lambda handlers, SSE
│   └── tests/                    # Vitest: router, auth, tools, store, sse
├── frontend/
│   ├── package.json              # Next.js 14 App Router
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx        # loads design tokens (globals.css)
│   │   │   ├── login/page.tsx
│   │   │   └── chat/page.tsx
│   │   ├── components/           # Topbar, ConversationList, MessageThread,
│   │   │   ...                   # Composer, AgentPill, ToolChip, ErrorCard
│   │   ├── lib/
│   │   │   ├── api.ts            # fetch wrapper w/ auth + 401→refresh retry
│   │   │   ├── sse.ts            # fetch-based SSE reader (POST body support)
│   │   │   └── auth-context.tsx  # session state, silent refresh
│   │   └── styles/globals.css    # Milgo design system, LTR port
│   └── tests/                    # component tests (Vitest + RTL) where valuable
└── docker-compose.yml            # dynamodb-local
```

---

## 2. Core Types (`core/types.ts`)

```ts
export interface Tool {
  name: string;
  description: string;                    // shown to the model
  inputSchema: Record<string, unknown>;   // JSON Schema for tool_use
  execute(input: unknown, ctx: ChatContext): Promise<ToolResult>;
}

export interface ToolResult { ok: boolean; content: string; }   // errors travel as content

export interface Agent {
  id: AgentId;                            // 'generic' | 'coding' | 'financial'
  displayName: string;                    // "Coding Agent" - shown in UI pill
  description: string;                    // used by the router classifier prompt
  systemPrompt: string;
  modelId: string;                        // Bedrock model id
  tools: Tool[];
}

export interface ChatContext {
  userId: string;
  conversationId: string;
  history: Message[];                     // last N turns
  signal: AbortSignal;                    // client disconnect → abort Bedrock
}

/** Every event that can travel down the SSE stream. */
export type StreamEvent =
  | { type: 'routing';     agent: AgentId; reason: 'llm' | 'fallback' }
  | { type: 'token';       text: string }
  | { type: 'tool_start';  tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; ok: boolean; summary: string }
  | { type: 'done';        messageId: string; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error';       code: ErrorCode; message: string };   // safe message only
```

**Extension contract (G2):** a new agent = new file exporting an `Agent` +
one line in `agents/registry.ts`. The router prompt is *generated from the
registry* (`AGENTS.map(a => `- ${a.id}: ${a.description}`)`), so routing picks
up new agents automatically - no router changes needed.

---

## 3. Router (`core/router.ts`)

```ts
export async function route(message: string, history: Message[]): Promise<{agent: Agent, reason: 'llm'|'fallback'}> {
  try {
    const res = await withTimeout(2000, classify(message, history));  // Haiku, JSON output
    if (isValidAgentId(res.agent)) return { agent: AGENTS[res.agent], reason: 'llm' };
  } catch { /* fall through */ }
  return { agent: keywordFallback(message), reason: 'fallback' };
}
```

- **Classifier call**: Bedrock Converse, `claude-haiku`, `maxTokens: 50`,
  forced-JSON via a tool-choice trick (single `choose_agent` tool with an enum
  of registry ids) - guarantees parseable output.
- **`keywordFallback`**: scored keyword lists per agent (e.g. coding:
  `code|function|bug|typescript|python|error stack`; financial:
  `invest|stock|budget|loan|interest|retirement`); tie or no hit → `generic`.
- Router never throws: worst case is `generic` via fallback. Unit-tested against
  a fixture set of ~30 labeled prompts.

## 4. Agent Loop (`core/agent-loop.ts`)

Uses Bedrock **Converse Stream** API (uniform tool-use across models).

```
messages = [system, ...history, user]
for turn in 1..MAX_TOOL_TURNS (3):
    stream = bedrock.converseStream(model, messages, tools)
    for chunk in stream:
        contentBlockDelta(text)  -> emit {type:'token', text}
        toolUse block collected  -> buffer
    if stopReason == 'tool_use':
        emit tool_start; result = tool.execute(input, ctx)   // try/catch → ok:false
        emit tool_result; messages += [assistant(toolUse), user(toolResult)]
        continue
    else: break
emit done
```

- `ctx.signal` (client disconnected) aborts the Bedrock stream → no orphan spend.
- `MAX_TOOL_TURNS = 3` bounds cost and prompt-injection loops.
- Partial-failure rule: if the stream dies after tokens were emitted, persist
  the partial assistant message flagged `truncated: true`, then emit `error`.

## 5. DynamoDB Single-Table Design

Table `assistant-platform` - `PK` (S), `SK` (S), GSI1 (`GSI1PK`,`GSI1SK`), TTL attr `expiresAt`.

| Entity | PK | SK | GSI1PK / GSI1SK | Notes |
|---|---|---|---|---|
| User | `USER#<userId>` | `PROFILE` | `EMAIL#<email>` / `USER` | bcrypt hash, createdAt |
| RefreshToken | `USER#<userId>` | `RT#<tokenId>` | - | `familyId`, `rotatedTo?`, TTL 7d |
| Conversation | `USER#<userId>` | `CONV#<ts>#<convId>` | - | title, lastMessageAt, agent of last reply |
| Message | `CONV#<convId>` | `MSG#<ts>#<msgId>` | - | role, content, agentId, toolCalls[], truncated? |

Access patterns (all `Query`, no `Scan`):
1. Login: user by email → GSI1 `EMAIL#<email>`.
2. List conversations: `PK = USER#id`, `begins_with(SK, 'CONV#')`, newest first.
3. Load history: `PK = CONV#id`, `begins_with(SK,'MSG#')`, `Limit N`, reverse.
4. Refresh rotation: `Get` `RT#<tokenId>`; reuse detection via `rotatedTo` set.

Local: `docker compose up dynamodb-local`; `store/client.ts` points at
`http://localhost:8000` when `DYNAMO_ENDPOINT` is set; a `createTable` script
provisions the schema (mirrors SAM template exactly).

## 6. API Contract

Base URL local: `http://localhost:4000`. All bodies JSON. Errors:
`{ error: { code, message } }`.

| Method & path | Auth | Request | Success |
|---|---|---|---|
| `POST /auth/signup` | - | `{ email, password }` (password ≥ 8) | `201 { user, accessToken, refreshToken }` |
| `POST /auth/login` | - | `{ email, password }` | `200 { user, accessToken, refreshToken }` |
| `POST /auth/refresh` | - | `{ refreshToken }` | `200 { accessToken, refreshToken }` (rotated) |
| `POST /auth/logout` | - | `{ refreshToken }` | `200 { ok: true }` (always - revokes the token's family, never leaks validity) |
| `GET /conversations` | Bearer | - | `200 { conversations: [...] }` |
| `GET /conversations/:id/messages` | Bearer | - | `200 { messages: [...] }` |
| `POST /chat` | Bearer | `{ conversationId?, message }` | `200` `text/event-stream` (below) |

### SSE wire format (`POST /chat`)

```
event: routing
data: {"agent":"coding","reason":"llm"}

event: token
data: {"text":"Here's a"}

event: tool_start
data: {"tool":"code_interpreter","input":{"code":"..."}}

event: tool_result
data: {"tool":"code_interpreter","ok":true,"summary":"exit 0, printed 42"}

event: done
data: {"messageId":"...","usage":{"inputTokens":812,"outputTokens":304}}
```

Failure mid-stream: `event: error` + `data: {"code":"AGENT_STREAM_FAILED","message":"..."}` then close.
Auth failure happens **before** streaming starts → plain `401` JSON.
Client reads via `fetch` + `ReadableStream` (native `EventSource` can't POST or send headers) - parser in `frontend/src/lib/sse.ts`.

## 7. Auth Details

- **Passwords**: `bcrypt`, cost 10; validated server-side (min length 8).
- **Access JWT**: HS256, secret from env, 15 min TTL. Claims: `sub` (userId), `email`, `iat`, `exp`. Verified in every protected handler via shared `requireAuth(event)`.
- **Refresh rotation**: opaque random token (256-bit) stored hashed in DynamoDB with `familyId`. `/auth/refresh` marks the old record `rotatedTo=<newId>`; presenting an already-rotated token **revokes the whole family** (stolen-token detection). The mark is a conditional write (`attribute_not_exists(rotatedTo)`), so two truly concurrent rotations can't both win - the loser is treated as reuse.
- **Client refresh is single-flight**: tokens are single-use, so concurrent 401 retries / multiple tabs / StrictMode double-effects share one in-flight `/auth/refresh` promise (`frontend/src/lib/api.ts`). Without this, the second concurrent refresh trips the theft detector and logs the user out.
- **Logout**: `POST /auth/logout` revokes the refresh-token family server-side; the client also clears local state first so signing out works offline (fire-and-forget).
- **Client storage trade-off** (documented in README): access token in memory only; refresh token in `localStorage`. httpOnly cookies would be stronger but require same-site API domains + CSRF handling - out of scope for the take-home, called out as production hardening.

## 8. Tools

### 8.1 Web Search (`tools/web-search.ts`)
- Tavily `POST /search`, `max_results: 5`, 5s timeout.
- Output to model: numbered `title - url - snippet` list (bounded ~2KB).
- Failure (timeout/quota/network) → `ToolResult { ok:false, content:"search unavailable: <reason>" }` - the model is instructed to answer from its own knowledge and say the search failed.

### 8.2 Code Interpreter (`tools/code-interpreter.ts`)
- Executes **JavaScript only** in a `child_process.fork` sandbox runner:
  - runner script deletes `process.binding`, blocks `require`/`import` (empty module allowlist), no network primitives available.
  - hard kill at 5s; stdout+stderr captured, capped at 64KB.
- Result: `{ ok, content: "exit <code>\nstdout:\n...\nstderr:\n..." }`.
- Explicitly *not* a general sandbox (documented): production would use Firecracker/isolated Lambda per execution.

## 9. Frontend LLD

### 9.1 Design system - Milgo port (LTR)
`styles/globals.css` carries over the exact tokens from
`Milgo/internal-tool/frontend/src/styles.css`:

```css
:root {
  --font-sans: 'Google Sans', 'Inter', system-ui, sans-serif;
  --primary: #071b35;  --primary-hover: #0d2c4d;
  --accent:  #0cccda;  --accent-hover:  #0bb6c4;  --accent-soft: #e8fbfc;
  --ink: #111; --muted: #666; --tertiary: #888;
  --bg: #fff; --bg-2: #fafafa; --line: #eaeaea;
  --success:#16a34a; --warning:#f59e0b; --danger:#dc2626;   /* + surface/on variants */
  --radius: 6px;
}
```

**Branding**: the Cross River logo (bright-blue `#18a0e0` wordmark + infinity
ribbon) lives at `frontend/public/cross-river-logo.png` and appears in two
places, mirroring Milgo's usage: `.brand-logo` in the Topbar (height 22px) and
the login card header (height 34px, like `.dash-logo`). The logo's own blue is
close enough to `--accent: #0cccda` that both sit comfortably on the white
flat surfaces; tokens stay exactly as in Milgo.

Reused component vocabulary (same class names, LTR direction): `.topbar`,
`.btn (primary|outline|secondary|ghost|sm|lg)`, `.card`, `.field`, `.pill`,
`.status-pill`, `.dd` dropdown, `.cv-drawer`, `.io-pre` (code blocks),
`.bubble-typing` dots (reused as the streaming indicator), focus ring
`0 0 0 3px rgba(12,204,218,.16)`. Base font 14px, headings with
`letter-spacing: -0.02em`, hairline borders, no layout shadows.

### 9.2 Pages & components

```
/login                      LoginCard (.card, .field, .btn.primary)
/chat                       AppShell
  ├── Topbar                brand + user email + logout (.topbar)
  ├── ConversationList      left rail, .run-row-like rows, active = .accent-soft
  └── ChatPane
      ├── MessageThread     user msgs right-aligned plain; assistant msgs in .card
      │     ├── AgentPill   .pill.agent - "Coding Agent" per message
      │     ├── ToolChip    .phase-pill.running/done - live tool activity
      │     ├── Markdown    code blocks rendered in .io-pre style
      │     └── ErrorCard   .insp-error style for event:error
      └── Composer          textarea + .btn.primary send; disabled while streaming;
                            Stop button aborts the fetch (cancels stream)
```

### 9.3 State & session
- `auth-context.tsx`: `{ user, accessToken }` in React state; on mount, tries `refresh` from stored refresh token (silent login). `api.ts` retries exactly once on 401 via refresh; failure → redirect `/login`.
- Streaming state machine per message: `routing → streaming → tooling → streaming → done | error`; the UI pill/typing dots follow it.
- Route guard: `/chat` redirects to `/login` when no session.
- Responsive: conversation rail collapses into a drawer (`.cv-drawer`) under 720px, mirroring Milgo's breakpoint.

## 10. Security Controls

| Threat | Control | Where |
|---|---|---|
| Credential stuffing / brute force | Per-IP token bucket on `/auth/*` (5 attempts/min, then `429`); generic `AUTH_INVALID_CREDENTIALS` for both unknown email and wrong password; `bcrypt.compare` against a dummy hash when the user doesn't exist (constant-ish timing) | `handlers/auth.ts` |
| Chat abuse / cost blowout | Per-user token bucket on `/chat` (10 msg/min); message length cap (8KB); history window cap; `MAX_TOOL_TURNS = 3` | `handlers/chat.ts`, `core/agent-loop.ts` |
| IDOR (reading others' data) | Conversations keyed under `USER#<sub>`; message reads first verify `conversation.userId === jwt.sub` → `404` (not `403`, avoids existence leak) | `store/conversations.ts` |
| Stolen refresh token | Rotation with reuse detection: presenting a rotated token revokes the whole `familyId` | `auth/tokens.ts` |
| NoSQL injection | DocumentClient parameterized expression values only; ids are server-generated ULIDs; zod rejects non-conforming input before any store call | `store/*` |
| XSS via model output | Markdown rendered through `react-markdown` + `rehype-sanitize`; no `dangerouslySetInnerHTML`; code blocks are text nodes in `.io-pre` | `MessageThread` |
| Prompt injection via tool results | Search snippets wrapped in `<search_results>` delimiters with "untrusted data, not instructions" framing; tool loop bounded; interpreter sandboxed | `tools/*`, agent system prompts |
| Sandbox escape (code interpreter) | Forked child with empty module allowlist (no `require`/`import`), no network primitives, 5s hard kill, 64KB output cap, runs with no env secrets (`env: {}`) | `tools/code-interpreter.ts` |
| CSRF / cross-origin | CORS allowlist = frontend origin only; Bearer-header auth (not cookies) is inherently CSRF-resistant | `local/server.ts` / API GW config |
| Oversized payloads | JSON body limit 32KB; SSE output caps per event | Express/API GW config |
| Secret leakage | Secrets only via env/SSM; logger redacts `password`, `refreshToken`, `Authorization` | `core/errors.ts` logger |

## 11. Error Taxonomy (`core/errors.ts`)

| Code | HTTP / SSE | Trigger |
|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | bad login |
| `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_INVALID` | 401 | JWT verify fail |
| `AUTH_REFRESH_REUSED` | 401 | rotation reuse → family revoked |
| `VALIDATION_FAILED` | 400 | zod-validated bodies |
| `ROUTING_FAILED` | (internal) | never surfaces - fallback path |
| `AGENT_STREAM_FAILED` | SSE `error` | Bedrock stream error mid-response |
| `TOOL_FAILED` | (in-band) | travels as `tool_result ok:false` |
| `STORAGE_UNAVAILABLE` | 503 / SSE `error` | DynamoDB errors |
| `RATE_LIMITED` | 429 | per-user in-memory token bucket (10 msg/min) |

One boundary per entrypoint (`toHttpError`, `toSseError`) - handlers never
hand-roll status codes; unknown errors → generic 500/`INTERNAL`, details logged.

## 12. Testing Plan (Vitest)

| Suite | What it proves |
|---|---|
| `router.test.ts` | ~30 labeled prompts route correctly; classifier failure → fallback; malformed LLM JSON → fallback; never throws |
| `tokens.test.ts` | JWT sign/verify, expiry, refresh rotation, **reuse revokes family** |
| `passwords.test.ts` | hash/verify roundtrip, rejects short passwords |
| `agent-loop.test.ts` | with mock LLM: token events ordered, tool_use → execute → resume, MAX_TOOL_TURNS cap, abort mid-stream |
| `code-interpreter.test.ts` | runs code, enforces timeout kill, blocks `require('fs')`, caps output |
| `web-search.test.ts` | maps API response, timeout → ok:false |
| `store/*.test.ts` | key mapping (PK/SK) per entity, email GSI lookup (against dynamodb-local) |
| `sse.test.ts` (frontend) | parser handles split chunks, multi-event frames, error events |

CI-friendly: everything except `store/*` runs with the mock LLM and no network.

## 13. Configuration

| Var | Local example | Notes |
|---|---|---|
| `JWT_SECRET` | dev-secret | SSM in AWS |
| `AWS_REGION` | us-east-1 | Bedrock + DynamoDB |
| `BEDROCK_ROUTER_MODEL` | anthropic claude-haiku id | routing |
| `BEDROCK_AGENT_MODEL` | anthropic claude-sonnet id | answers |
| `DYNAMO_TABLE` | assistant-platform | |
| `DYNAMO_ENDPOINT` | http://localhost:8000 | unset in AWS |
| `TAVILY_API_KEY` | tvly-... | web search |
| `LLM_PROVIDER` | bedrock \| mock | mock = no creds needed |

## 14. Implementation Order

1. Scaffold backend (TS, Vitest, Express adapter) + docker-compose dynamodb-local.
2. Auth vertical: store → tokens → handlers → tests.
3. LLM layer: bedrock.ts + mock.ts; agent-loop with token streaming (no tools yet).
4. Router + registry + 3 agents; SSE endpoint end-to-end with mock.
5. Tools: web search, code interpreter; wire into loop.
6. Persistence of conversations/messages; list endpoints.
7. Frontend: globals.css (Milgo port) → login → chat shell → SSE renderer → tool chips.
8. SAM template + deploy notes; README + demo script.

## 15. Feature Extensions (v2)

Added after the original submission; same conventions (transport-neutral
handlers, Store contract with memory + Dynamo implementations, zod at the
edges, IDOR-safe keys, 404-not-403).

### 15.1 Message branching (edit & regenerate)
`Message.parentId` turns each conversation into a tree (`null` = root; absent
= legacy row that chains onto the previous message in stored order, so old
conversations need no migration). `core/thread.ts` (mirrored in
`frontend/src/lib/thread.ts`) computes root→leaf paths; the default path
follows the newest child at every fork. `/chat` accepts `parentMessageId`
(edit-branch anchor) and `regenerate: true` (re-answer an existing user
message as a sibling assistant). The `routing` SSE event carries
`userMessageId` and `done` carries `messageId` so the client can wire its
optimistic bubbles to real tree nodes. UI: hover a message → edit / regenerate;
`◀ n/m ▶` pager hops between sibling branches.

### 15.2 Cross-session memory
`MemoryRecord` per user (`PK=USER#id SK=MEM#<memId>`, cap 100, oldest evicted).
After each persisted turn, `core/memory.ts` asks the router-tier model (forced
`save_memories` tool call, 4s timeout, best-effort) whether the user message
contains durable facts; new facts are stored, deduped against the known list,
and announced in-band via a `memory` SSE event ("Memory updated" chip). Facts
are injected into every agent's system prompt when present. Controls:
`memoryEnabled` setting gates both directions; Settings → Memory lists,
deletes, and wipes facts. Incognito chats neither read nor write memory.

### 15.3 Custom instructions
`UserSettingsRecord` (`SK=SETTINGS`) holds `customInstructions` (≤2000 chars),
appended to the system prompt of every agent, clearly framed as user
preferences. Persona presets in the UI are just canned instruction texts.

### 15.4 Attachments (multi-modal input)
`/chat` accepts up to 4 base64 attachments: images (png/jpeg/gif/webp ≤3.5MB,
sent as provider image blocks via the new `LlmContentBlock` image variant) and
text files (≤48KB, inlined inside `<attachment>` delimiters with the same
untrusted-data framing as search results). Only metadata is persisted
(DynamoDB items cap at 400KB): images inform the turn they were sent in and
history keeps a `[attachments: …]` note. Production path: S3 + presigned URLs.
The composer validates types/sizes, previews images, accepts pasted
screenshots, and offers Web Speech dictation where the browser supports it.

### 15.5 MCP connectors
Users connect remote MCP servers (Settings → Connectors): `McpServerRecord`
(`SK=MCP#<serverId>`, ≤5/user) stores name, URL, optional bearer token
(write-only - responses expose `hasAuth`, never the token), an enabled flag,
and a tools snapshot from the last probe. `mcp/client.ts` wraps the official
SDK: Streamable HTTP first, legacy SSE fallback, connect→act→close per call,
8s/20s timeouts. `mcp/tools.ts` adapts snapshots into agent-loop tools named
`mcp_<server>_<tool>` (sanitized, collision-proof, so connectors can never
shadow built-ins) with results wrapped in `<mcp_result>` untrusted framing.
SSRF: URLs must be http(s); private/loopback hosts are rejected unless
`MCP_ALLOW_LOCAL=true` (dev default; deployed template pins false). DNS
rebinding is documented out of scope.

### 15.6 History search, lifecycle, feedback, privacy
- `GET /conversations/search?q=`: case-insensitive over titles (all) and
  message bodies (newest 30 conversations, first hit per conversation, with a
  snippet). Production: DynamoDB Streams → OpenSearch.
- `PATCH/DELETE /conversations/:id`, `DELETE /conversations` (wipe),
  `POST .../messages/:msgId/feedback` (`up`/`down`/null + optional comment,
  stored on the message).
- Incognito (`ephemeral: true`): zero store writes, client supplies the
  history window, memory fully bypassed.
- New routes ride one dispatcher Lambda (`userDataHandler`, routeKey → handler)
  to avoid 15 single-route functions.

### 15.7 Frontend additions
Markdown: `remark-gfm` (tables), `remark-math`+`rehype-katex` (LaTeX),
`rehype-highlight` (syntax colors), sanitize-first pipeline, copy buttons and
language labels on code blocks. Artifacts panel collects ≥6-line fenced blocks
from answers into a side pane (tabs, copy, download) that updates while
streaming. Keyboard shortcuts (defaults ⌘K search, ⌘⇧O new chat, ⌘⇧I
incognito, Esc stop) are rebindable in Settings → Shortcuts via
`lib/shortcuts.ts`: click-to-record capture-phase listener, reserved-key and
conflict validation, `mod` = ⌘-or-Ctrl so bindings port across platforms,
persisted in localStorage next to the other device-local UI prefs; every
surface that displays a binding (rail placeholder, incognito tooltip,
empty-state hint) renders the live value. Enter / Shift+Enter / Esc stay
fixed. Settings modal hosts personalization / memory / connectors / privacy /
shortcuts.

### 15.8 UX pass
Streaming follow-scroll only sticks while the user is at the bottom (scrolling
up to re-read is never hijacked; a sticky "Jump to latest" pill returns);
conversation switches and new turns always snap down. Rail groups history by
recency (Today/Yesterday/Previous 7 days/Older) with shimmer skeletons during
loads; the thread shows skeletons while a conversation fetches. Failed
responses carry an inline "Try again" (regenerate). Unsent composer drafts are
kept per conversation and restored on switch-back. Focus management targets
fine-pointer devices only (no mobile keyboard pop-ups): composer focuses on
load, new chat, conversation open, and after a stream ends if focus is idle.
Mobile: drawers get tap-to-close scrims; Enter inserts a newline on coarse
pointers (send via button). The character counter appears only past 80% of
the limit. Accessibility: focus-visible rings on all icon-level controls,
overscroll containment on panels, `prefers-reduced-motion` disables
decorative animation, hover timestamps on messages.
