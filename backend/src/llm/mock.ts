import type { LlmChunk, LlmClient, LlmStreamRequest } from './types';

export interface MockLlmOptions {
  /** Scripted chunk sequences - call N yields script[N]. When exhausted (or absent), falls back to canned behavior. */
  script?: LlmChunk[][];
  /** Every call throws (router fallback / error-path tests). */
  failWith?: Error;
}

/**
 * Deterministic LLM for tests and credential-free local dev (LLM_PROVIDER=mock).
 * - Forced `choose_agent` calls (the router) classify by keyword so routing
 *   behaves sensibly in dev.
 * - Otherwise streams a canned word-by-word response.
 */
export function createMockClient(opts: MockLlmOptions = {}): LlmClient {
  let call = 0;

  return {
    async *converseStream(req: LlmStreamRequest): AsyncIterable<LlmChunk> {
      if (opts.failWith) throw opts.failWith;

      const scripted = opts.script?.[call];
      call += 1;
      if (scripted) {
        for (const chunk of scripted) {
          yield chunk;
        }
        return;
      }

      const lastUserText = [...req.messages]
        .reverse()
        .flatMap((m) => (m.role === 'user' ? m.content : []))
        .map((b) => ('text' in b ? b.text : ''))
        .find((t) => t.length > 0) ?? '';

      if (req.forceTool === 'save_memories') {
        // Deterministic memory extraction: explicit self-disclosures only.
        const m = lastUserText.match(
          /\b(?:remember that|my name is|i prefer|i work|i am a|i'm a|call me)\b[^.!?\n]*/i,
        );
        const memories = m ? [m[0].trim().slice(0, 200)] : [];
        yield { type: 'toolUseStart', toolUseId: 'mock-mem', name: 'save_memories' };
        yield { type: 'toolUseInput', partialJson: JSON.stringify({ memories }) };
        yield { type: 'messageStop', stopReason: 'tool_use' };
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
        return;
      }

      if (req.forceTool === 'choose_agent') {
        const agent = /\b(code|coding|function|bug|typescript|javascript|python|error|compile)\b/i.test(lastUserText)
          ? 'coding'
          : /\b(invest|stock|budget|loan|interest|mortgage|retirement|portfolio|finance|financial|savings?)\b/i.test(lastUserText)
            ? 'financial'
            : 'generic';
        yield { type: 'toolUseStart', toolUseId: 'mock-choice', name: 'choose_agent' };
        yield { type: 'toolUseInput', partialJson: JSON.stringify({ agent }) };
        yield { type: 'messageStop', stopReason: 'tool_use' };
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
        return;
      }

      // Dev hook: include REFUSE_TEST in a message to exercise the provider-refusal path.
      if (/\bREFUSE_TEST\b/.test(lastUserText)) {
        yield { type: 'text', text: 'Starting to answer... ' };
        yield {
          type: 'messageStop',
          stopReason: 'refusal',
          refusal: { category: 'mock', explanation: 'This is a simulated provider refusal (mock).' },
        };
        yield { type: 'usage', inputTokens: 10, outputTokens: 3 };
        return;
      }

      const imageCount = [...req.messages]
        .reverse()
        .find((m) => m.role === 'user' && m.content.some((b) => 'image' in b))
        ?.content.filter((b) => 'image' in b).length ?? 0;

      const reply =
        `${imageCount > 0 ? `[mock: received ${imageCount} image${imageCount > 1 ? 's' : ''}] ` : ''}` +
        `This is a mock response to: "${lastUserText.slice(0, 80)}". Set LLM_PROVIDER=bedrock for real answers.`;
      for (const word of reply.split(/(?<= )/)) {
        yield { type: 'text', text: word };
        await new Promise((r) => setTimeout(r, 15)); // visible streaming in dev
      }
      yield { type: 'messageStop', stopReason: 'end_turn' };
      yield { type: 'usage', inputTokens: 25, outputTokens: reply.split(' ').length };
    },
  };
}
