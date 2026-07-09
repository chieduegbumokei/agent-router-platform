import type { AgentId, StreamEvent, ToolCallSummary } from './types';

/**
 * Live pipeline run state: pure reducers that turn the chat SSE events into
 * per-node statuses/details for the canvas. Node ids:
 *   router · agent:<id> · tool:<agentId>:<toolName> · response
 */

export interface AgentMeta {
  id: AgentId;
  displayName: string;
  description: string;
  tools: string[];
}

/** Fallback mirror of the backend registry, used if GET /agents fails. */
export const DEFAULT_AGENTS: AgentMeta[] = [
  { id: 'generic', displayName: 'Generic Agent', description: 'General queries', tools: ['web_search'] },
  { id: 'coding', displayName: 'Coding Agent', description: 'Code generation', tools: ['code_interpreter'] },
  { id: 'financial', displayName: 'Financial Advisor', description: 'Financial guidance', tools: ['web_search'] },
];

export type StageStatus = 'pending' | 'active' | 'done' | 'failed';

export interface StageInfo {
  status: StageStatus;
  detail?: string;
  input?: string;
  output?: string;
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
  /** Real prompt/completion token counts from the terminal `done` event (response node). */
  inputTokens?: number;
  outputTokens?: number;
}

export interface RunState {
  live: boolean;
  chosenAgent?: AgentId;
  nodes: Record<string, StageInfo>;
  /**
   * `tool:<agentId>:<tool>` ids in first-invocation order. Built-in tools are
   * known ahead of time from the agent registry, but MCP connector tools are
   * per-user and dynamic - this is the only reliable way to know which tool
   * nodes actually ran in this turn, and in what order, so the canvas can
   * show them regardless of where they came from.
   */
  toolOrder: string[];
}

export const agentNode = (id: AgentId) => `agent:${id}`;
export const toolNode = (agentId: AgentId, tool: string) => `tool:${agentId}:${tool}`;

export function fmtDuration(stage: StageInfo | undefined): string {
  if (!stage?.startedAt || !stage.endedAt) return '';
  return `${((stage.endedAt - stage.startedAt) / 1000).toFixed(1)}s`;
}

function baseNodes(agents: AgentMeta[]): Record<string, StageInfo> {
  const nodes: Record<string, StageInfo> = { router: { status: 'pending' }, response: { status: 'pending' } };
  for (const a of agents) {
    nodes[agentNode(a.id)] = { status: 'pending' };
    for (const t of a.tools) nodes[toolNode(a.id, t)] = { status: 'pending' };
  }
  return nodes;
}

/** Before any message is sent. */
export function idleRun(agents: AgentMeta[]): RunState {
  return { live: false, nodes: baseNodes(agents), toolOrder: [] };
}

/** A message was just sent: everything resets, the router lights up. */
export function startRun(agents: AgentMeta[], message: string, now = Date.now()): RunState {
  const nodes = baseNodes(agents);
  nodes['router'] = {
    status: 'active',
    detail: 'classifying intent…',
    input: message,
    startedAt: now,
  };
  return { live: true, nodes, toolOrder: [] };
}

/** Apply one SSE event. Pure: returns a new state. */
export function applyEvent(run: RunState, event: StreamEvent, now = Date.now()): RunState {
  const nodes = { ...run.nodes };
  const patch = (id: string, p: Partial<StageInfo>) => {
    nodes[id] = { ...(nodes[id] ?? { status: 'pending' }), ...p };
  };
  let chosenAgent = run.chosenAgent;
  let live = run.live;
  let toolOrder = run.toolOrder;

  switch (event.type) {
    case 'routing': {
      chosenAgent = event.agent;
      patch('router', {
        status: 'done',
        detail: `${event.agent} · via ${event.reason === 'llm' ? 'LLM classifier' : 'keyword fallback'}`,
        output: JSON.stringify({ agent: event.agent, reason: event.reason }, null, 2),
        endedAt: now,
      });
      patch(agentNode(event.agent), {
        status: 'active',
        detail: 'generating…',
        startedAt: now,
      });
      break;
    }
    case 'token': {
      if (chosenAgent) {
        const agent = nodes[agentNode(chosenAgent)];
        const tokens = (agent?.tokens ?? 0) + 1;
        patch(agentNode(chosenAgent), { tokens, detail: `${tokens} chunks streamed…` });
      }
      patch('response', { output: (nodes['response']?.output ?? '') + event.text });
      break;
    }
    case 'tool_start': {
      if (chosenAgent) {
        const id = toolNode(chosenAgent, event.tool);
        if (!toolOrder.includes(id)) toolOrder = [...toolOrder, id];
        patch(id, {
          status: 'active',
          detail: 'running…',
          input: JSON.stringify(event.input, null, 2),
          startedAt: now,
        });
        patch(agentNode(chosenAgent), { detail: `waiting on ${event.tool}…` });
      }
      break;
    }
    case 'tool_result': {
      if (chosenAgent) {
        const id = toolNode(chosenAgent, event.tool);
        patch(id, {
          status: event.ok ? 'done' : 'failed',
          detail: event.ok ? event.summary.slice(0, 60) : `failed: ${event.summary.slice(0, 48)}`,
          output: event.summary,
          endedAt: now,
        });
        patch(agentNode(chosenAgent), { detail: 'generating…' });
      }
      break;
    }
    case 'done': {
      live = false;
      if (chosenAgent) {
        const agent = nodes[agentNode(chosenAgent)];
        patch(agentNode(chosenAgent), {
          status: 'done',
          detail: `${agent?.tokens ?? 0} chunks`,
          endedAt: now,
        });
      }
      patch('response', {
        status: 'done',
        detail: `${event.usage.inputTokens} in · ${event.usage.outputTokens} out tokens`,
        endedAt: now,
        startedAt: nodes['router']?.startedAt,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
      });
      break;
    }
    case 'refusal': {
      // Provider declined mid-run; the notice is part of the answer text.
      if (chosenAgent) {
        patch(agentNode(chosenAgent), { detail: `declined by ${event.provider}` });
      }
      patch('response', {
        output: (nodes['response']?.output ?? '') + (nodes['response']?.output ? '\n\n' : '') + event.message,
      });
      break;
    }
    case 'error': {
      live = false;
      // whatever is currently active takes the failure
      for (const [id, stage] of Object.entries(nodes)) {
        if (stage.status === 'active') {
          patch(id, { status: 'failed', detail: event.message.slice(0, 60), endedAt: now });
        }
      }
      if (!Object.values(nodes).some((n) => n.status === 'failed')) {
        patch('router', { status: 'failed', detail: event.message.slice(0, 60), endedAt: now });
      }
      patch('response', { status: 'failed', detail: event.code });
      break;
    }
  }

  return { live, chosenAgent, nodes, toolOrder };
}

/** The user pressed Stop or the stream dropped without a terminal event. */
export function interruptRun(run: RunState, now = Date.now()): RunState {
  if (!run.live) return run;
  const nodes = { ...run.nodes };
  for (const [id, stage] of Object.entries(nodes)) {
    if (stage.status === 'active') nodes[id] = { ...stage, status: 'failed', detail: 'interrupted', endedAt: now };
  }
  return { ...run, live: false, nodes };
}

/* ===========================================================================
   Run recording & playback: every SSE event is captured with its wall-clock
   timestamp so a finished run can be replayed step-by-step on the canvas.
   =========================================================================== */

export interface TimedEvent {
  event: StreamEvent;
  at: number;
}

export interface RunRecord {
  /** The user message that started the run (router input). */
  message: string;
  startedAt: number;
  endedAt?: number;
  /** True when the stream stopped without a terminal done/error event. */
  interrupted?: boolean;
  events: TimedEvent[];
}

/** Rebuild the run state as it looked after the first `upTo` events. Pure. */
export function replayRun(agents: AgentMeta[], record: RunRecord, upTo: number): RunState {
  let run = startRun(agents, record.message, record.startedAt);
  const n = Math.max(0, Math.min(upTo, record.events.length));
  for (let i = 0; i < n; i++) run = applyEvent(run, record.events[i].event, record.events[i].at);
  if (n === record.events.length && record.interrupted) {
    run = interruptRun(run, record.endedAt ?? record.startedAt);
  }
  return run;
}

/** How long auto-play lingers on event `index` (tokens tick fast, stages slow). */
export function playbackDelay(record: RunRecord, index: number): number {
  return record.events[index]?.event.type === 'token' ? 24 : 650;
}

function chunkText(text: string, parts: number): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / parts));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * Approximate a RunRecord for a message loaded from history (no live events
 * were captured): routing → recorded tool calls → chunked tokens → done.
 */
export function synthesizeRecord(
  userMessage: string,
  msg: { content: string; agentId?: AgentId; toolCalls?: ToolCallSummary[]; truncated?: boolean },
  startedAt = 0,
): RunRecord | null {
  if (!msg.agentId) return null;
  let t = startedAt;
  const at = (ms: number) => (t += ms);
  const events: TimedEvent[] = [
    { event: { type: 'routing', agent: msg.agentId, reason: 'llm', conversationId: '', userMessageId: '' }, at: at(500) },
  ];
  for (const tc of msg.toolCalls ?? []) {
    events.push({ event: { type: 'tool_start', tool: tc.tool, input: {} }, at: at(400) });
    events.push({ event: { type: 'tool_result', tool: tc.tool, ok: tc.ok, summary: tc.summary }, at: at(900) });
  }
  for (const chunk of chunkText(msg.content, 14)) {
    events.push({ event: { type: 'token', text: chunk }, at: at(120) });
  }
  if (msg.truncated) return { message: userMessage, startedAt, endedAt: t, interrupted: true, events };
  events.push({
    event: { type: 'done', messageId: 'replay', usage: { inputTokens: 0, outputTokens: 0 } },
    at: at(200),
  });
  return { message: userMessage, startedAt, endedAt: t, events };
}

/* ===========================================================================
   Chat activity steps: a Claude-style timeline of what the run is doing
   ("Routing → Agent thinking → Using tool → Writing response"), rendered
   inside the assistant bubble with a pointer on the current step.
   =========================================================================== */

export type ChatStepStatus = 'running' | 'done' | 'failed';

export interface ChatStep {
  id: string;
  kind: 'route' | 'think' | 'tool' | 'write';
  label: string;
  detail?: string;
  status: ChatStepStatus;
}

export function startSteps(): ChatStep[] {
  return [{ id: 'route', kind: 'route', label: 'Routing request', detail: 'choosing the right agent…', status: 'running' }];
}

function summarizeInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  const s = typeof input === 'string' ? input : JSON.stringify(input);
  if (!s || s === '{}') return undefined;
  return s.length > 70 ? `${s.slice(0, 70)}…` : s;
}

/** Apply one SSE event to the step timeline. Pure: returns a new array. */
export function applyEventToSteps(steps: ChatStep[], event: StreamEvent, agents: AgentMeta[]): ChatStep[] {
  const next = steps.map((s) => ({ ...s }));
  const current = () => [...next].reverse().find((s) => s.status === 'running');

  switch (event.type) {
    case 'routing': {
      const name = agents.find((a) => a.id === event.agent)?.displayName ?? event.agent;
      const route = next.find((s) => s.id === 'route');
      if (route) {
        route.status = 'done';
        route.detail = `${name} · ${event.reason === 'llm' ? 'LLM classifier' : 'keyword fallback'}`;
      }
      next.push({ id: `think-${next.length}`, kind: 'think', label: `${name} is thinking`, status: 'running' });
      break;
    }
    case 'token': {
      const cur = current();
      if (cur && cur.kind === 'think') {
        cur.kind = 'write';
        cur.label = 'Writing response';
        cur.detail = undefined;
      }
      break;
    }
    case 'tool_start': {
      const cur = current();
      if (cur) cur.status = 'done';
      next.push({
        id: `tool-${next.length}`,
        kind: 'tool',
        label: `Using ${event.tool}`,
        detail: summarizeInput(event.input),
        status: 'running',
      });
      break;
    }
    case 'tool_result': {
      const tool = [...next].reverse().find((s) => s.kind === 'tool');
      if (tool) {
        tool.status = event.ok ? 'done' : 'failed';
        tool.detail = event.summary.slice(0, 80);
      }
      next.push({ id: `write-${next.length}`, kind: 'write', label: 'Writing response', status: 'running' });
      break;
    }
    case 'refusal': {
      const cur = current();
      if (cur) {
        cur.kind = 'write';
        cur.label = `Declined by ${event.provider}`;
        cur.detail = event.message.slice(0, 80);
      }
      break;
    }
    case 'done': {
      for (const s of next) if (s.status === 'running') s.status = 'done';
      break;
    }
    case 'error': {
      for (const s of next)
        if (s.status === 'running') {
          s.status = 'failed';
          s.detail = event.message.slice(0, 80);
        }
      break;
    }
  }
  return next;
}

/** The user pressed Stop mid-run: the running step fails as interrupted. */
export function interruptSteps(steps: ChatStep[]): ChatStep[] {
  return steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' as const, detail: 'interrupted' } : s));
}
