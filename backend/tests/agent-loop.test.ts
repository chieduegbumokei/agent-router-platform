import { describe, expect, it } from 'vitest';
import { runAgentTurn, type AgentRunResult } from '../src/core/agent-loop';
import type { Agent, ChatContext, StreamEvent, Tool } from '../src/core/types';
import { createMockClient } from '../src/llm/mock';
import type { LlmChunk } from '../src/llm/types';

const echoTool: Tool = {
  name: 'echo',
  description: 'echoes input',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  execute: async (input) => ({ ok: true, content: `echo: ${JSON.stringify(input)}` }),
};

const failingTool: Tool = {
  name: 'echo',
  description: 'always throws',
  inputSchema: { type: 'object' },
  execute: async () => {
    throw new Error('tool exploded');
  },
};

const makeAgent = (tools: Tool[]): Agent => ({
  id: 'generic',
  displayName: 'Test Agent',
  description: 'test',
  systemPrompt: 'test',
  modelId: 'test-model',
  tools,
});

const makeCtx = (): ChatContext => ({
  userId: 'u1',
  conversationId: 'c1',
  history: [],
  signal: new AbortController().signal,
});

async function collect(
  gen: AsyncGenerator<StreamEvent, AgentRunResult>,
): Promise<{ events: StreamEvent[]; result: AgentRunResult }> {
  const events: StreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

const textTurn: LlmChunk[] = [
  { type: 'text', text: 'Hello ' },
  { type: 'text', text: 'world' },
  { type: 'messageStop', stopReason: 'end_turn' },
  { type: 'usage', inputTokens: 10, outputTokens: 2 },
];

const toolTurn: LlmChunk[] = [
  { type: 'text', text: 'Let me check. ' },
  { type: 'toolUseStart', toolUseId: 't1', name: 'echo' },
  { type: 'toolUseInput', partialJson: '{"value":' },
  { type: 'toolUseInput', partialJson: '"42"}' },
  { type: 'messageStop', stopReason: 'tool_use' },
  { type: 'usage', inputTokens: 10, outputTokens: 5 },
];

describe('runAgentTurn', () => {
  it('streams text tokens in order and returns the full text', async () => {
    const llm = createMockClient({ script: [textTurn] });
    const { events, result } = await collect(runAgentTurn(makeAgent([]), 'hi', makeCtx(), llm));

    expect(events.map((e) => e.type)).toEqual(['token', 'token']);
    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it('executes tool calls (split JSON deltas) and resumes the model', async () => {
    const llm = createMockClient({ script: [toolTurn, textTurn] });
    const { events, result } = await collect(
      runAgentTurn(makeAgent([echoTool]), 'use the tool', makeCtx(), llm),
    );

    expect(events.map((e) => e.type)).toEqual([
      'token',
      'tool_start',
      'tool_result',
      'token',
      'token',
    ]);
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({ ok: true, tool: 'echo' });
    expect(result.text).toBe('Let me check. Hello world');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('a throwing tool becomes ok:false, the loop continues', async () => {
    const llm = createMockClient({ script: [toolTurn, textTurn] });
    const { events, result } = await collect(
      runAgentTurn(makeAgent([failingTool]), 'use the tool', makeCtx(), llm),
    );
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
    expect(result.text).toContain('Hello world'); // model still answered
  });

  it('stops after MAX_TOOL_TURNS even if the model keeps asking for tools', async () => {
    // every turn requests a tool → loop must cap, not spin
    const llm = createMockClient({ script: [toolTurn, toolTurn, toolTurn, toolTurn, toolTurn] });
    const { result } = await collect(
      runAgentTurn(makeAgent([echoTool]), 'loop forever', makeCtx(), llm),
    );
    expect(result.toolCalls.length).toBeLessThanOrEqual(3);
  });

  it('an unknown tool name yields ok:false instead of crashing', async () => {
    const llm = createMockClient({ script: [toolTurn, textTurn] });
    const { events } = await collect(runAgentTurn(makeAgent([]), 'hm', makeCtx(), llm));
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
  });
});
