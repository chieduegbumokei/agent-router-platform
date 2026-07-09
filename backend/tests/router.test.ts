import { describe, expect, it } from 'vitest';
import { keywordFallback, route } from '../src/core/router';
import { createMockClient } from '../src/llm/mock';

const noHistory: never[] = [];

describe('keywordFallback', () => {
  const cases: Array<[string, string]> = [
    ['help me debug this typescript function', 'coding'],
    ['why does my code throw a null pointer error', 'coding'],
    ['write a regex that matches emails', 'coding'],
    ['should I invest in index funds or stocks', 'financial'],
    ['how much should I budget for a mortgage', 'financial'],
    ['explain compound interest rate on my savings', 'financial'],
    ['what is the capital of France', 'generic'],
    ['tell me a story about a dragon', 'generic'],
    ['how do airplanes stay in the air', 'generic'],
  ];

  it.each(cases)('"%s" → %s', (message, expected) => {
    expect(keywordFallback(message).id).toBe(expected);
  });
});

describe('route', () => {
  it('uses the LLM classification when it succeeds', async () => {
    const llm = createMockClient(); // mock classifies by keyword via forced choose_agent
    const res = await route('please fix this python bug', noHistory, llm);
    expect(res.reason).toBe('llm');
    expect(res.agent.id).toBe('coding');
  });

  it('falls back to keywords when the LLM fails', async () => {
    const llm = createMockClient({ failWith: new Error('bedrock down') });
    const res = await route('how do I budget for retirement', noHistory, llm);
    expect(res.reason).toBe('fallback');
    expect(res.agent.id).toBe('financial');
  });

  it('never throws - worst case is generic via fallback', async () => {
    const llm = createMockClient({ failWith: new Error('boom') });
    const res = await route('completely ambiguous text', noHistory, llm);
    expect(res.agent.id).toBe('generic');
    expect(res.reason).toBe('fallback');
  });

  it('falls back when the LLM returns an unknown agent id', async () => {
    const llm = createMockClient({
      script: [
        [
          { type: 'toolUseStart', toolUseId: 't1', name: 'choose_agent' },
          { type: 'toolUseInput', partialJson: '{"agent":"nonexistent"}' },
          { type: 'messageStop', stopReason: 'tool_use' },
        ],
      ],
    });
    const res = await route('anything at all', noHistory, llm);
    expect(res.reason).toBe('fallback');
  });
});
