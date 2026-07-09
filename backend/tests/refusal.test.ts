import { describe, expect, it } from 'vitest';
import { runAgentTurn, type AgentRunResult } from '../src/core/agent-loop';
import type { Agent, ChatContext, StreamEvent } from '../src/core/types';
import { createMockClient } from '../src/llm/mock';
import type { LlmChunk } from '../src/llm/types';

const agent: Agent = {
  id: 'generic',
  displayName: 'Test Agent',
  description: 'test',
  systemPrompt: 'test',
  modelId: 'test-model',
  tools: [],
};

const ctx: ChatContext = {
  userId: 'u1',
  conversationId: 'c1',
  history: [],
  signal: new AbortController().signal,
};

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

describe('provider refusal handling', () => {
  it('surfaces the provider explanation as a refusal event and persists it in the text', async () => {
    const script: LlmChunk[][] = [
      [
        { type: 'text', text: 'partial answer ' },
        {
          type: 'messageStop',
          stopReason: 'refusal',
          refusal: { category: 'policy', explanation: 'This request violates the usage policy.' },
        },
        { type: 'usage', inputTokens: 12, outputTokens: 3 },
      ],
    ];
    const llm = createMockClient({ script });

    const { events, result } = await collect(runAgentTurn(agent, 'blocked ask', ctx, llm));

    const refusal = events.find((e) => e.type === 'refusal');
    expect(refusal).toBeDefined();
    if (refusal?.type === 'refusal') {
      expect(refusal.category).toBe('policy');
      expect(refusal.message).toContain('This request violates the usage policy.');
    }
    // The notice is appended to the returned text so it gets persisted.
    expect(result.text).toContain('partial answer');
    expect(result.text).toContain('This request violates the usage policy.');
  });

  it('falls back to a generic notice when the provider gives no explanation', async () => {
    const script: LlmChunk[][] = [
      [
        { type: 'messageStop', stopReason: 'refusal' },
        { type: 'usage', inputTokens: 5, outputTokens: 0 },
      ],
    ];
    const llm = createMockClient({ script });

    const { events, result } = await collect(runAgentTurn(agent, 'blocked ask', ctx, llm));

    const refusal = events.find((e) => e.type === 'refusal');
    expect(refusal).toBeDefined();
    if (refusal?.type === 'refusal') {
      expect(refusal.message).toMatch(/declined to answer/i);
    }
    expect(result.text).toMatch(/declined to answer/i);
  });
});
