import type { LlmClient, LlmContentBlock, LlmMessage } from '../llm/types';
import { config } from './config';
import { logError } from './errors';
import type {
  Agent,
  ChatContext,
  Message,
  StreamEvent,
  Strictness,
  Tool,
  ToolCallSummary,
  Usage,
} from './types';

/** Strictness → sampling temperature + a system-prompt directive. */
export const STRICTNESS_PROFILES: Record<Strictness, { temperature: number; directive?: string }> = {
  strict: {
    temperature: 0.1,
    directive:
      'Answer with maximum precision. State only what you are confident is correct, prefer verified facts, and say so explicitly when you are unsure. Keep the answer tight and free of speculation.',
  },
  balanced: { temperature: 0.6 },
  creative: {
    temperature: 0.9,
    directive:
      'You may brainstorm, explore alternatives, and offer speculative ideas, as long as you clearly label speculation as such.',
  },
};

/** Display name for the active provider, used in user-facing refusal notices. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  bedrock: 'Amazon Bedrock',
};

export interface AgentRunResult {
  text: string;
  toolCalls: ToolCallSummary[];
  usage: Usage;
}

export interface RunOptions {
  /** Per-user dynamic tools (MCP connectors) merged with the agent's own. */
  extraTools?: Tool[];
  /** Appended to the system prompt: custom instructions, memory, etc. */
  systemSuffix?: string;
  /** Full content for the latest user message (attachments); defaults to text only. */
  userBlocks?: LlmContentBlock[];
}

interface PendingToolUse {
  toolUseId: string;
  name: string;
  inputJson: string;
}

/** History rows lose their raw attachment bytes; keep the model aware of them. */
function historyBlocks(m: Message): LlmContentBlock[] {
  if (!m.attachments?.length) return [{ text: m.content }];
  const note = m.attachments.map((a) => `${a.name} (${a.kind})`).join(', ');
  return [{ text: `${m.content}\n[attachments from this turn, no longer inline: ${note}]` }];
}

/**
 * Runs one user turn through an agent: stream model output, execute tool calls
 * as they occur, feed results back, repeat up to maxToolTurns. Yields
 * StreamEvents for the SSE pipe; the aggregate result (for persistence) is
 * available via the generator's return value.
 */
export async function* runAgentTurn(
  agent: Agent,
  userMessage: string,
  ctx: ChatContext,
  llm: LlmClient,
  strictness: Strictness = 'balanced',
  opts: RunOptions = {},
): AsyncGenerator<StreamEvent, AgentRunResult> {
  const profile = STRICTNESS_PROFILES[strictness];
  const system = [agent.systemPrompt, profile.directive, opts.systemSuffix]
    .filter(Boolean)
    .join('\n\n');
  const messages: LlmMessage[] = [
    ...ctx.history.map<LlmMessage>((m) => ({ role: m.role, content: historyBlocks(m) })),
    { role: 'user', content: opts.userBlocks ?? [{ text: userMessage }] },
  ];
  const allTools = [...agent.tools, ...(opts.extraTools ?? [])];
  const toolSpecs = allTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const toolByName = new Map(allTools.map((t) => [t.name, t]));

  let fullText = '';
  const toolCalls: ToolCallSummary[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };

  for (let turn = 0; turn < config.maxToolTurns; turn++) {
    let turnText = '';
    const pending: PendingToolUse[] = [];
    let stopReason = 'end_turn';
    let refusal: { category?: string; explanation?: string } | undefined;

    const stream = llm.converseStream({
      modelId: agent.modelId,
      system,
      messages,
      tools: toolSpecs.length ? toolSpecs : undefined,
      temperature: profile.temperature,
      signal: ctx.signal,
    });

    for await (const chunk of stream) {
      if (ctx.signal.aborted) return { text: fullText, toolCalls, usage };
      switch (chunk.type) {
        case 'text':
          turnText += chunk.text;
          fullText += chunk.text;
          yield { type: 'token', text: chunk.text };
          break;
        case 'toolUseStart':
          pending.push({ toolUseId: chunk.toolUseId, name: chunk.name, inputJson: '' });
          break;
        case 'toolUseInput': {
          const last = pending[pending.length - 1];
          if (last) last.inputJson += chunk.partialJson;
          break;
        }
        case 'messageStop':
          stopReason = chunk.stopReason;
          refusal = chunk.refusal;
          break;
        case 'usage':
          usage.inputTokens += chunk.inputTokens;
          usage.outputTokens += chunk.outputTokens;
          break;
      }
    }

    if (stopReason === 'refusal') {
      // Surface the provider's own rejection text instead of a generic error;
      // it becomes part of the persisted assistant message.
      const provider = PROVIDER_LABELS[config.llmProvider] ?? 'The model provider';
      const notice = refusal?.explanation
        ? `${provider} declined this request: ${refusal.explanation}`
        : `${provider} declined to answer this request for safety/policy reasons.`;
      fullText += (fullText ? '\n\n' : '') + notice;
      yield {
        type: 'refusal',
        provider,
        ...(refusal?.category ? { category: refusal.category } : {}),
        message: notice,
      };
      return { text: fullText, toolCalls, usage };
    }

    if (stopReason !== 'tool_use' || pending.length === 0) {
      return { text: fullText, toolCalls, usage };
    }

    // Model paused to use tools: echo its blocks back, execute, append results.
    const assistantBlocks: LlmContentBlock[] = [];
    if (turnText) assistantBlocks.push({ text: turnText });
    const resultBlocks: LlmContentBlock[] = [];

    for (const call of pending) {
      const input = safeParse(call.inputJson);
      yield { type: 'tool_start', tool: call.name, input };
      assistantBlocks.push({
        toolUse: { toolUseId: call.toolUseId, name: call.name, input },
      });

      const tool = toolByName.get(call.name);
      let ok = false;
      let content = `unknown tool: ${call.name}`;
      if (tool) {
        try {
          const result = await tool.execute(input, ctx);
          ok = result.ok;
          content = result.content;
        } catch (err) {
          logError(err);
          content = 'tool execution failed';
        }
      }
      const summary = content.slice(0, 200);
      toolCalls.push({ tool: call.name, ok, summary });
      yield { type: 'tool_result', tool: call.name, ok, summary };
      resultBlocks.push({
        toolResult: { toolUseId: call.toolUseId, content, status: ok ? 'success' : 'error' },
      });
    }

    messages.push({ role: 'assistant', content: assistantBlocks });
    messages.push({ role: 'user', content: resultBlocks });
  }

  return { text: fullText, toolCalls, usage };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}
