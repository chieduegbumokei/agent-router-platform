import type { Agent, AgentId } from '../core/types';
import { codingAgent } from './coding';
import { financialAgent } from './financial';
import { genericAgent } from './generic';

/**
 * The single extension point (HLD G2): to add an agent, create its file and
 * add it here. The router's classifier prompt and its tool enum are generated
 * from this map, so routing picks up new agents automatically.
 */
export const AGENTS: Record<AgentId, Agent> = {
  generic: genericAgent,
  coding: codingAgent,
  financial: financialAgent,
};

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

export const isAgentId = (v: unknown): v is AgentId =>
  typeof v === 'string' && (AGENT_IDS as string[]).includes(v);

export const DEFAULT_AGENT: Agent = genericAgent;
