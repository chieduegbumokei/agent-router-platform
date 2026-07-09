import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock as BedrockContentBlock,
  type Message as BedrockMessage,
  type Tool as BedrockTool,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from '../core/config';
import type { LlmChunk, LlmClient, LlmContentBlock, LlmStreamRequest } from './types';

/** Text/tool blocks are already Converse-shaped; images need base64 → bytes. */
function toBedrockBlock(b: LlmContentBlock): BedrockContentBlock {
  if ('image' in b) {
    return {
      image: { format: b.image.format, source: { bytes: Buffer.from(b.image.dataBase64, 'base64') } },
    };
  }
  return b as BedrockContentBlock;
}

/** Thin adapter: our provider-neutral request → Bedrock ConverseStream chunks. */
export function createBedrockClient(): LlmClient {
  const client = new BedrockRuntimeClient({ region: config.awsRegion });

  return {
    async *converseStream(req: LlmStreamRequest): AsyncIterable<LlmChunk> {
      const tools: BedrockTool[] | undefined = req.tools?.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.inputSchema as never },
        },
      }));

      const command = new ConverseStreamCommand({
        modelId: req.modelId,
        system: req.system ? [{ text: req.system }] : undefined,
        messages: req.messages.map(
          (m): BedrockMessage => ({ role: m.role, content: m.content.map(toBedrockBlock) }),
        ),
        inferenceConfig: {
          maxTokens: req.maxTokens ?? 2048,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        },
        ...(tools
          ? {
              toolConfig: {
                tools,
                ...(req.forceTool ? { toolChoice: { tool: { name: req.forceTool } } } : {}),
              },
            }
          : {}),
      });

      const res = await client.send(command, { abortSignal: req.signal });
      if (!res.stream) return;

      for await (const event of res.stream) {
        if (event.contentBlockStart?.start?.toolUse) {
          const t = event.contentBlockStart.start.toolUse;
          yield { type: 'toolUseStart', toolUseId: t.toolUseId ?? '', name: t.name ?? '' };
        } else if (event.contentBlockDelta?.delta?.text !== undefined) {
          yield { type: 'text', text: event.contentBlockDelta.delta.text };
        } else if (event.contentBlockDelta?.delta?.toolUse?.input !== undefined) {
          yield { type: 'toolUseInput', partialJson: event.contentBlockDelta.delta.toolUse.input };
        } else if (event.messageStop) {
          const reason = event.messageStop.stopReason as string;
          if (reason === 'guardrail_intervened' || reason === 'content_filtered') {
            // Bedrock doesn't stream an explanation; the reason itself is the detail.
            yield {
              type: 'messageStop',
              stopReason: 'refusal',
              refusal: {
                category: reason,
                explanation:
                  reason === 'guardrail_intervened'
                    ? 'The request was blocked by an Amazon Bedrock guardrail.'
                    : 'The request was blocked by the Amazon Bedrock content filter.',
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
        } else if (event.metadata?.usage) {
          yield {
            type: 'usage',
            inputTokens: event.metadata.usage.inputTokens ?? 0,
            outputTokens: event.metadata.usage.outputTokens ?? 0,
          };
        }
      }
    },
  };
}
