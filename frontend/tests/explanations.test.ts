import { describe, expect, it } from 'vitest';
import { explainNode } from '../src/lib/explanations';
import type { AgentMeta } from '../src/lib/pipeline';

const agents: AgentMeta[] = [
  { id: 'generic', displayName: 'Generic Agent', description: 'General queries.', tools: ['web_search'] },
  { id: 'coding', displayName: 'Coding Agent', description: 'Writes code.', tools: ['code_interpreter'] },
  { id: 'financial', displayName: 'Financial Advisor', description: 'Money stuff.', tools: [] },
];

describe('explainNode', () => {
  it('describes the router node', () => {
    const text = explainNode('router', agents);
    expect(text).toContain('classifies your intent');
    expect(text).toContain('choose_agent');
  });

  it('describes the response node', () => {
    const text = explainNode('response', agents);
    expect(text).toContain('DynamoDB');
    expect(text).toContain('truncated');
  });

  it('describes an agent node using its metadata and tool list', () => {
    const text = explainNode('agent:coding', agents);
    expect(text).toContain('Coding Agent');
    expect(text).toContain('Writes code.');
    expect(text).toContain('code_interpreter');
  });

  it('says "no tools" for an agent that has none', () => {
    const text = explainNode('agent:financial', agents);
    expect(text).toContain('Financial Advisor');
    expect(text).toContain('no tools');
  });

  it('falls back gracefully for an agent id not in the registry', () => {
    const text = explainNode('agent:unknown', agents);
    expect(text).toContain('unknown'); // uses the raw id as the name
    expect(text).toContain('no tools');
  });

  it('describes known tool nodes from the tool explanations table', () => {
    expect(explainNode('tool:coding:code_interpreter', agents)).toContain('isolated child process');
    expect(explainNode('tool:generic:web_search', agents)).toContain('Tavily');
  });

  it('gives a generic description for an unknown tool', () => {
    expect(explainNode('tool:coding:mystery_tool', agents)).toBe('External tool invoked by the agent.');
  });

  it('returns an empty string for an unrecognised node id', () => {
    expect(explainNode('nonsense', agents)).toBe('');
    expect(explainNode('', agents)).toBe('');
  });
});
