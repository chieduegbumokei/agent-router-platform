import { AGENTS, AGENT_IDS, DEFAULT_AGENT, isAgentId } from '../agents/registry';
import type { LlmClient } from '../llm/types';
import { config } from './config';
import type { Agent, Message } from './types';

export interface RouteResult {
  agent: Agent;
  reason: 'llm' | 'fallback';
}

/**
 * Router agent: a cheap, fast LLM call classifies intent; a keyword heuristic
 * is the fallback. Never throws - worst case is the generic agent.
 */
export async function route(
  message: string,
  history: Message[],
  llm: LlmClient,
): Promise<RouteResult> {
  try {
    const agentId = await withTimeout(config.routerTimeoutMs, classify(message, history, llm));
    if (isAgentId(agentId)) return { agent: AGENTS[agentId], reason: 'llm' };
  } catch {
    // fall through to keyword routing
  }
  return { agent: keywordFallback(message), reason: 'fallback' };
}

/**
 * Forced tool-choice classification: the model MUST call choose_agent with an
 * enum of registry ids, which guarantees parseable output (no JSON coaxing).
 * The prompt is generated from the registry so new agents route automatically.
 */
async function classify(message: string, history: Message[], llm: LlmClient): Promise<string> {
  const catalogue = Object.values(AGENTS)
    .map((a) => `- ${a.id}: ${a.description}`)
    .join('\n');
  const recent = history
    .slice(-4)
    .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join('\n');

  let inputJson = '';
  const stream = llm.converseStream({
    modelId: config.routerModel,
    system: `You are a routing classifier. Pick the best specialized agent for the user's message.\nAgents:\n${catalogue}`,
    messages: [
      {
        role: 'user',
        content: [
          {
            text: `${recent ? `Recent conversation:\n${recent}\n\n` : ''}User message:\n${message}`,
          },
        ],
      },
    ],
    tools: [
      {
        name: 'choose_agent',
        description: 'Select the agent that should handle this message',
        inputSchema: {
          type: 'object',
          properties: { agent: { type: 'string', enum: AGENT_IDS } },
          required: ['agent'],
        },
      },
    ],
    forceTool: 'choose_agent',
    maxTokens: 64,
  });

  for await (const chunk of stream) {
    if (chunk.type === 'toolUseInput') inputJson += chunk.partialJson;
  }
  const parsed = JSON.parse(inputJson || '{}') as { agent?: string };
  return parsed.agent ?? '';
}

const KEYWORDS: Array<{ agent: Agent; pattern: RegExp }> = [
  {
    agent: AGENTS.coding,
    pattern:
      /\b(code|coding|program|function|bug|debug|compile|typescript|javascript|python|java\b|sql|regex|api|stack trace|error message|algorithm|refactor)\b/i,
  },
  {
    agent: AGENTS.financial,
    pattern:
      /\b(invest(ing|ment)?|stocks?|budget|loan|mortgage|interest rate|retirement|portfolio|financ(e|ial)|savings?|401k|etf|crypto|tax(es)?)\b/i,
  },
];

export function keywordFallback(message: string): Agent {
  for (const { agent, pattern } of KEYWORDS) {
    if (pattern.test(message)) return agent;
  }
  return DEFAULT_AGENT;
}

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('router timeout')), ms).unref?.()),
  ]);
}
