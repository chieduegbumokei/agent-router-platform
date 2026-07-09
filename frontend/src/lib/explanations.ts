import type { AgentMeta } from './pipeline';

/**
 * Human-readable explanations for each pipeline stage, shown in the
 * inspector's Explanation tab (mirrors Milgo's lib/explanations pattern).
 */

const TOOL_EXPLANATIONS: Record<string, string> = {
  web_search:
    'Queries the Tavily search API for current information (top 5 results, 5s timeout). Results are wrapped in <search_results> delimiters and treated as untrusted data: the agent may cite them but never follow instructions found inside. If the search fails, the agent answers from its own knowledge and says the search was unavailable.',
  code_interpreter:
    'Executes JavaScript the agent writes inside an isolated child process: no imports, no network, no filesystem, empty environment, hard-killed after 5 seconds, output capped at 64KB. The console output is fed back to the agent so it can verify its code actually works before presenting it.',
};

export function explainNode(nodeId: string, agents: AgentMeta[]): string {
  if (nodeId === 'router') {
    return (
      'Every message starts here. A small, fast LLM (Claude Haiku on Bedrock) classifies your intent and is forced to answer through a choose_agent tool, so the output is always a valid agent id. ' +
      'If the call errors or takes more than 2 seconds, a keyword heuristic routes instead - routing can never fail your request. The agent list in its prompt is generated from the backend registry, so newly added agents are routed to automatically.'
    );
  }
  if (nodeId === 'response') {
    return (
      'The final assistant message, assembled from the streamed tokens. Once complete it is persisted to the conversation in DynamoDB together with which agent answered, any tool calls made, and token usage. ' +
      'If the stream is interrupted, the partial text is kept and flagged as truncated.'
    );
  }
  if (nodeId.startsWith('agent:')) {
    const id = nodeId.slice('agent:'.length);
    const meta = agents.find((a) => a.id === id);
    const toolList = meta?.tools.length ? meta.tools.join(', ') : 'no tools';
    return (
      `${meta?.displayName ?? id}: ${meta?.description ?? ''} ` +
      `Streams its answer token-by-token via Bedrock ConverseStream (Claude Sonnet) and may pause mid-answer to call its tools (${toolList}), feeding results back before continuing - up to 3 tool turns per message. ` +
      'Your Answer style setting adjusts this agent’s sampling temperature and adds a precision or exploration directive to its instructions.'
    );
  }
  if (nodeId.startsWith('tool:')) {
    const tool = nodeId.split(':')[2] ?? '';
    if (tool.startsWith('mcp_')) {
      return (
        'Calls a tool exposed by one of your connected MCP servers (Settings → Connectors, or the composer’s + → Connectors). ' +
        'Each call opens a fresh connection to the connector and closes it right after - stateless, so a slow or unreachable server only costs its own timeout, never the whole turn. ' +
        'The result is wrapped in <mcp_result> delimiters and treated as untrusted data the agent can cite but must not follow as instructions, the same containment used for web search.'
      );
    }
    return TOOL_EXPLANATIONS[tool] ?? 'External tool invoked by the agent.';
  }
  return '';
}
