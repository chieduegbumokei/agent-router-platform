import { describe, expect, it } from 'vitest';
import { AGENT_IDS, AGENTS, DEFAULT_AGENT, isAgentId } from '../src/agents/registry';
import { genericAgent } from '../src/agents/generic';

describe('agent registry', () => {
  it('exposes exactly the three known agents', () => {
    expect(AGENT_IDS.sort()).toEqual(['coding', 'financial', 'generic']);
  });

  it('keys the map by each agent\'s own id (router relies on this invariant)', () => {
    for (const [key, agent] of Object.entries(AGENTS)) {
      expect(agent.id).toBe(key);
    }
  });

  it('gives every agent the metadata the router prompt needs', () => {
    for (const agent of Object.values(AGENTS)) {
      expect(agent.displayName.length).toBeGreaterThan(0);
      expect(agent.description.length).toBeGreaterThan(0);
      expect(agent.systemPrompt.length).toBeGreaterThan(0);
      expect(agent.modelId.length).toBeGreaterThan(0);
    }
  });

  it('defaults to the generic agent', () => {
    expect(DEFAULT_AGENT).toBe(genericAgent);
    expect(DEFAULT_AGENT.id).toBe('generic');
  });
});

describe('isAgentId', () => {
  it('accepts known agent ids', () => {
    expect(isAgentId('generic')).toBe(true);
    expect(isAgentId('coding')).toBe(true);
    expect(isAgentId('financial')).toBe(true);
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isAgentId('marketing')).toBe(false);
    expect(isAgentId('')).toBe(false);
    expect(isAgentId(undefined)).toBe(false);
    expect(isAgentId(null)).toBe(false);
    expect(isAgentId(42)).toBe(false);
    expect(isAgentId({ id: 'coding' })).toBe(false);
  });
});
