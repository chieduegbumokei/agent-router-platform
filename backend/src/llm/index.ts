import { config } from '../core/config';
import { createAnthropicClient } from './anthropic';
import { createBedrockClient } from './bedrock';
import { createMockClient } from './mock';
import type { LlmClient } from './types';

let instance: LlmClient | null = null;

export function getLlm(): LlmClient {
  if (!instance) {
    instance =
      config.llmProvider === 'bedrock' ? createBedrockClient()
      : config.llmProvider === 'anthropic' ? createAnthropicClient()
      : createMockClient();
  }
  return instance;
}

/** Test hook. */
export function setLlm(client: LlmClient): void {
  instance = client;
}

export type { LlmClient, LlmChunk, LlmMessage, LlmContentBlock, LlmStreamRequest, LlmToolSpec } from './types';
