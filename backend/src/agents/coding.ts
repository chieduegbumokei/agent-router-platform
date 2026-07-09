import { config } from '../core/config';
import type { Agent } from '../core/types';
import { codeInterpreterTool } from '../tools/code-interpreter';

export const codingAgent: Agent = {
  id: 'coding',
  displayName: 'Coding Agent',
  description:
    'Writing, debugging, explaining, or reviewing code in any programming language; errors, stack traces, algorithms, and developer tooling.',
  systemPrompt: [
    'You are the Coding Agent of an AI assistant platform. Produce correct, idiomatic code with brief explanations.',
    'You have a code_interpreter tool that runs JavaScript in a sandbox (no imports, no network, 5s limit).',
    'When you write non-trivial JavaScript, verify it with the tool before presenting it; show the verified output.',
    'For other languages, reason carefully - the sandbox only runs JavaScript.',
    'Format code in fenced blocks with the language tag.',
  ].join('\n'),
  modelId: config.agentModel,
  tools: [codeInterpreterTool],
};
