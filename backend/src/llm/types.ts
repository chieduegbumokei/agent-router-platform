/**
 * Provider-neutral LLM streaming contract, shaped after Bedrock's Converse API
 * so the bedrock adapter stays thin and the mock stays honest.
 */

export type LlmImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export type LlmContentBlock =
  | { text: string }
  | { image: { format: LlmImageFormat; dataBase64: string } }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: string; status: 'success' | 'error' } };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmContentBlock[];
}

export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmStreamRequest {
  modelId: string;
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  /** Force the model to call this specific tool (used by the router classifier). */
  forceTool?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type LlmChunk =
  | { type: 'text'; text: string }
  | { type: 'toolUseStart'; toolUseId: string; name: string }
  | { type: 'toolUseInput'; partialJson: string }
  | {
      type: 'messageStop';
      stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
      /** Present when stopReason is 'refusal': the provider's own rejection details. */
      refusal?: { category?: string; explanation?: string };
    }
  | { type: 'usage'; inputTokens: number; outputTokens: number };

export interface LlmClient {
  converseStream(req: LlmStreamRequest): AsyncIterable<LlmChunk>;
}
