import { describe, expect, it } from 'vitest';
import { runAgentTurn, STRICTNESS_PROFILES } from '../src/core/agent-loop';
import type { Agent, ChatContext } from '../src/core/types';
import type { LlmChunk, LlmClient, LlmStreamRequest } from '../src/llm/types';

const agent: Agent = {
  id: 'generic',
  displayName: 'Test Agent',
  description: 'test',
  systemPrompt: 'You are a test agent.',
  modelId: 'test-model',
  tools: [],
};

const ctx: ChatContext = {
  userId: 'u1',
  conversationId: 'c1',
  history: [],
  signal: new AbortController().signal,
};

/** LLM double that records the request it was given. */
function capturingLlm(): { llm: LlmClient; requests: LlmStreamRequest[] } {
  const requests: LlmStreamRequest[] = [];
  const llm: LlmClient = {
    async *converseStream(req): AsyncIterable<LlmChunk> {
      requests.push(req);
      yield { type: 'text', text: 'ok' };
      yield { type: 'messageStop', stopReason: 'end_turn' };
    },
  };
  return { llm, requests };
}

async function drain(gen: AsyncGenerator<unknown, unknown>) {
  let r = await gen.next();
  while (!r.done) r = await gen.next();
}

describe('strictness profiles', () => {
  it('strict: low temperature + precision directive appended to the system prompt', async () => {
    const { llm, requests } = capturingLlm();
    await drain(runAgentTurn(agent, 'q', ctx, llm, 'strict'));
    expect(requests[0]?.temperature).toBe(STRICTNESS_PROFILES.strict.temperature);
    expect(requests[0]?.system).toContain('You are a test agent.');
    expect(requests[0]?.system).toContain('maximum precision');
  });

  it('balanced (default): mid temperature, prompt untouched', async () => {
    const { llm, requests } = capturingLlm();
    await drain(runAgentTurn(agent, 'q', ctx, llm));
    expect(requests[0]?.temperature).toBe(STRICTNESS_PROFILES.balanced.temperature);
    expect(requests[0]?.system).toBe('You are a test agent.');
  });

  it('creative: high temperature + exploration directive', async () => {
    const { llm, requests } = capturingLlm();
    await drain(runAgentTurn(agent, 'q', ctx, llm, 'creative'));
    expect(requests[0]?.temperature).toBe(STRICTNESS_PROFILES.creative.temperature);
    expect(requests[0]?.system).toContain('label speculation');
  });

  it('temperatures are ordered strict < balanced < creative', () => {
    expect(STRICTNESS_PROFILES.strict.temperature).toBeLessThan(
      STRICTNESS_PROFILES.balanced.temperature,
    );
    expect(STRICTNESS_PROFILES.balanced.temperature).toBeLessThan(
      STRICTNESS_PROFILES.creative.temperature,
    );
  });
});
