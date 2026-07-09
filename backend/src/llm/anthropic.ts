import Anthropic from '@anthropic-ai/sdk';
import { config } from '../core/config';
import { providerQuotaExceeded } from '../core/errors';
import type { LlmChunk, LlmClient, LlmContentBlock, LlmStreamRequest } from './types';

function toAnthropicContent(blocks: LlmContentBlock[]): Anthropic.ContentBlockParam[] {
  return blocks.map((b): Anthropic.ContentBlockParam => {
    if ('text' in b) return { type: 'text', text: b.text };
    if ('image' in b)
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: `image/${b.image.format}`,
          data: b.image.dataBase64,
        },
      };
    if ('toolUse' in b)
      return {
        type: 'tool_use',
        id: b.toolUse.toolUseId,
        name: b.toolUse.name,
        input: b.toolUse.input ?? {},
      };
    return {
      type: 'tool_result',
      tool_use_id: b.toolResult.toolUseId,
      content: b.toolResult.content,
      ...(b.toolResult.status === 'error' ? { is_error: true } : {}),
    };
  });
}

/** Thin adapter: our provider-neutral request → Anthropic Messages API stream events. */
export function createAnthropicClient(): LlmClient {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  return {
    async *converseStream(req: LlmStreamRequest): AsyncIterable<LlmChunk> {
      const stream = client.messages.stream(
        {
          model: req.modelId,
          max_tokens: req.maxTokens ?? 2048,
          ...(req.system ? { system: req.system } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          messages: req.messages.map((m) => ({
            role: m.role,
            content: toAnthropicContent(m.content),
          })),
          ...(req.tools
            ? {
                tools: req.tools.map(
                  (t): Anthropic.Tool => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                  }),
                ),
                ...(req.forceTool
                  ? { tool_choice: { type: 'tool' as const, name: req.forceTool } }
                  : {}),
              }
            : {}),
        },
        { signal: req.signal },
      );

      let inputTokens = 0;
      let outputTokens = 0;

      try {
        for await (const event of stream) {
          if (event.type === 'message_start') {
            inputTokens = event.message.usage.input_tokens;
          } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            yield { type: 'toolUseStart', toolUseId: event.content_block.id, name: event.content_block.name };
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', text: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              yield { type: 'toolUseInput', partialJson: event.delta.partial_json };
            }
          } else if (event.type === 'message_delta') {
            outputTokens = event.usage.output_tokens ?? outputTokens;
            const reason = event.delta.stop_reason;
            if (reason === 'refusal') {
              // stop_details carries Anthropic's own rejection text (category + explanation).
              const details = (
                event.delta as { stop_details?: { category?: string | null; explanation?: string | null } }
              ).stop_details;
              yield {
                type: 'messageStop',
                stopReason: 'refusal',
                refusal: {
                  ...(details?.category ? { category: details.category } : {}),
                  ...(details?.explanation ? { explanation: details.explanation } : {}),
                },
              };
            } else {
              yield {
                type: 'messageStop',
                stopReason:
                  reason === 'tool_use' ? 'tool_use'
                  : reason === 'end_turn' ? 'end_turn'
                  : reason === 'max_tokens' ? 'max_tokens'
                  : 'other',
              };
            }
          } else if (event.type === 'message_stop') {
            yield { type: 'usage', inputTokens, outputTokens };
          }
        }
      } catch (err) {
        // `billing_error` is Anthropic's first-class signal for an exhausted
        // credit balance - surface it as a clear, user-facing notice instead
        // of the generic "agent failed" fallback.
        if (err instanceof Anthropic.APIError && err.type === 'billing_error') {
          throw providerQuotaExceeded();
        }
        throw err;
      }
    },
  };
}
