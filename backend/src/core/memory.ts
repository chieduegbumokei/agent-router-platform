import type { LlmClient } from '../llm/types';
import { config } from './config';

/**
 * Cross-session memory extraction: after each persisted turn, the cheap router
 * model is asked (forced tool call → guaranteed parseable) whether the user's
 * message contained durable facts worth remembering. Best-effort by design -
 * any failure or timeout returns [] and never disturbs the chat stream.
 */
export async function extractMemories(
  llm: LlmClient,
  userMessage: string,
  existing: string[],
): Promise<string[]> {
  if (userMessage.trim().length < 15) return [];

  const existingList = existing.slice(0, 50).map((m) => `- ${m}`).join('\n');
  const run = async (): Promise<string[]> => {
    let inputJson = '';
    const stream = llm.converseStream({
      modelId: config.routerModel,
      system: [
        'You maintain long-term memory for an assistant. Decide if the user message contains durable facts about the USER worth remembering across future conversations.',
        'Save only: stable preferences, personal/professional context (role, stack, goals), ongoing projects, or explicit "remember that..." requests.',
        'Never save: one-off task details, questions, sensitive data (passwords, keys, health, finances beyond stated goals), or anything already in the known list.',
        existingList ? `Already known:\n${existingList}` : 'Nothing is known about the user yet.',
        'Each memory is one short third-person sentence ("Prefers TypeScript over Python"). Return an empty list when nothing qualifies - that is the common case.',
      ].join('\n\n'),
      messages: [{ role: 'user', content: [{ text: `User message:\n${userMessage.slice(0, 2_000)}` }] }],
      tools: [
        {
          name: 'save_memories',
          description: 'Record durable facts about the user (empty list when none)',
          inputSchema: {
            type: 'object',
            properties: {
              memories: { type: 'array', items: { type: 'string' }, maxItems: 3 },
            },
            required: ['memories'],
          },
        },
      ],
      forceTool: 'save_memories',
      maxTokens: 300,
    });
    for await (const chunk of stream) {
      if (chunk.type === 'toolUseInput') inputJson += chunk.partialJson;
    }
    const parsed = JSON.parse(inputJson || '{}') as { memories?: unknown };
    if (!Array.isArray(parsed.memories)) return [];
    const known = new Set(existing.map((m) => m.toLowerCase().trim()));
    return parsed.memories
      .filter((m): m is string => typeof m === 'string')
      .map((m) => m.trim().slice(0, 300))
      .filter((m) => m.length >= 8 && !known.has(m.toLowerCase()))
      .slice(0, 3);
  };

  try {
    return await Promise.race([
      run(),
      new Promise<string[]>((resolve) =>
        setTimeout(() => resolve([]), config.memoryExtractTimeoutMs).unref?.(),
      ),
    ]);
  } catch {
    return [];
  }
}
