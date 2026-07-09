# Cost Analysis - AI-Powered Assistant Platform

> Goal: prove the system cannot silently burn money. Every cost driver is
> bounded by an explicit guardrail in code, and the worst case per user per day
> is a known number, not a surprise.

Pricing used (per million tokens, Claude on Bedrock; matches first-party API
rates - re-check AWS pricing before production):

| Model | Role | Input $/1M | Output $/1M |
|---|---|---|---|
| Claude Haiku 4.5 (`BEDROCK_ROUTER_MODEL`) | routing classifier | $1.00 | $5.00 |
| Claude Sonnet 4.5 (`BEDROCK_AGENT_MODEL`) | agent answers | $3.00 | $15.00 |

Dev mode (`LLM_PROVIDER=mock`, the default) makes **zero** LLM calls - local
development and CI cost $0.

## 1. Cost per message

### Router call (every message)
- Input: system + agent catalogue + last 4 history snippets + message ≈ 800 tokens
- Output: forced `choose_agent` tool call, `maxTokens: 64` cap ≈ 15 tokens
- **≈ $0.0009 per message** - routing is effectively free ($0.90 per 1,000 messages)

### Agent call (every message)
Bounded by config (`backend/src/core/config.ts`):
message ≤ 8,000 chars (~2K tokens), history window 20 messages, `maxTokens`
2,048 output per model turn, tool loop ≤ 3 turns, tool output ≤ ~2KB fed back.

| Scenario | Input tokens | Output tokens | Cost |
|---|---|---|---|
| Typical (no tools, short history) | ~2,500 | ~500 | **~$0.015** |
| Typical with 1 tool call | ~6,000 | ~1,200 | **~$0.036** |
| Worst case (3 tool turns, full history, max output) | ~30,000 | ~6,150 | **~$0.18** |

The worst case is a *ceiling*, not an estimate - it requires a user maxing the
message size, a full history window, and the model exhausting all 3 tool turns
at full output length on every turn.

## 2. Worst case per user per day (the number that matters)

Rate limits (enforced in `handlers/chat.ts`):
- 10 messages/minute (token bucket per user)
- **200 messages/day (hard daily cap per user, `CHAT_RATE_PER_DAY`)**

| | Typical | Absolute worst case |
|---|---|---|
| Per message (router + agent) | ~$0.016 | ~$0.18 |
| Per user per day (200-msg cap) | **~$3.20** | **~$36** |
| 10 demo users, one day | ~$32 | ~$360 |

For a take-home demo the realistic exposure is a few dollars; even a hostile
authenticated user is capped at ~$36/day, and signup itself is rate-limited
per IP so an attacker cannot mint unlimited users quickly.

## 3. Non-LLM costs (rounding errors at this scale)

| Service | Driver | Cost |
|---|---|---|
| Lambda | chat fn 1GB × ~20s streaming per message | ~$0.0003/message; free tier covers demos |
| API Gateway | auth/list requests | $1.00/million requests |
| DynamoDB (on-demand) | ~4 writes + ~3 reads per message | ~$0.000007/message; refresh tokens auto-expire via TTL (no storage creep) |
| Tavily web search | 1 call per web_search tool use | free tier 1,000 searches/month; tool degrades gracefully (`ok:false`) when quota is gone - never blocks answers |

LLM tokens are >95% of total cost; that is where all the guardrails live.

## 4. Guardrails: how each cost driver is bounded in code

| Cost risk | Guardrail | Where |
|---|---|---|
| Unauthenticated Bedrock spend | JWT verified **before** any model call | `handlers/chat.ts` (pre-stream phase) |
| Burst abuse | 10 msg/min per user | `chatLimiter`, `handlers/chat.ts` |
| Sustained abuse | **200 msg/day per user** (env-tunable) | `dailyLimiter`, `handlers/chat.ts` |
| Account minting | 5 auth attempts/min per IP | `authLimiter`, `handlers/auth.ts` |
| Giant prompts | message ≤ 8,000 chars; body ≤ 32KB | zod schema + Express/API GW limit |
| Unbounded context growth | history window = last 20 messages | `config.historyWindow` |
| Runaway tool loops (prompt injection) | max 3 tool turns per message | `config.maxToolTurns`, `agent-loop.ts` |
| Runaway generation | `maxTokens: 2048` per model turn; router capped at 64 | `llm/bedrock.ts`, `core/router.ts` |
| Paying for abandoned requests | client disconnect aborts the Bedrock stream immediately | `AbortSignal` through `agent-loop.ts` |
| Expensive routing | router uses Haiku (~1/3 input, 1/3 output price of Sonnet), one tiny call | `core/router.ts` |
| Tool-result bloat | search results capped ~2KB; interpreter output 64KB → 200-char summary to stream | `tools/*` |
| Fat model where a small one works | routing on Haiku; only answers use Sonnet | model split in `config.ts` |

Known limitation (documented in LLD §10): the rate limiters are in-memory, so
on Lambda they are per-instance. A determined attacker fanning across N warm
instances could multiply the caps by N. Production hardening: API Gateway
usage plans or a DynamoDB atomic counter for the daily cap - plus the two
platform-level backstops below, which are instance-independent.

## 5. Platform-level backstops (recommended before real traffic)

Code guardrails bound *per-user* spend; these bound *total* spend:

1. **AWS Budgets** - monthly budget with an alert at e.g. $50 and an
   SNS-triggered hard stop action.
2. **CloudWatch alarm on Bedrock token metrics** - alert when
   `InputTokenCount`/`OutputTokenCount` for the account exceeds a daily
   threshold.
3. **Bedrock model-invocation logging** - per-request token accounting for
   audit and per-user cost attribution (the `done` SSE event already surfaces
   usage per message in the UI pipeline panel).

## 6. Levers if costs need to drop further

- Lower `CHAT_RATE_PER_DAY` (env var, no deploy needed if set in Lambda config).
- Swap `BEDROCK_AGENT_MODEL` to Haiku 4.5 (~$0.003 typical per message, 5x cheaper) - one env var, thanks to the LLM adapter.
- Reduce `historyWindow` (context is the biggest input-token driver).
- Add prompt caching for the static agent system prompts (Bedrock supports cache points; ~90% discount on the cached prefix).
