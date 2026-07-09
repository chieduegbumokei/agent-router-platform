import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/lib/sse';
import type { StreamEvent } from '../src/lib/types';

function collector() {
  const events: StreamEvent[] = [];
  const parser = createSseParser((e) => events.push(e));
  return { events, parser };
}

const frame = (e: object) => `event: x\ndata: ${JSON.stringify(e)}\n\n`;

describe('SSE parser', () => {
  it('parses a single complete frame', () => {
    const { events, parser } = collector();
    parser.push(frame({ type: 'token', text: 'hello' }));
    expect(events).toEqual([{ type: 'token', text: 'hello' }]);
  });

  it('handles a frame split across arbitrary chunk boundaries', () => {
    const { events, parser } = collector();
    const full = frame({ type: 'token', text: 'split across chunks' });
    // feed one character at a time - worst-case network fragmentation
    for (const ch of full) parser.push(ch);
    expect(events).toEqual([{ type: 'token', text: 'split across chunks' }]);
  });

  it('handles multiple frames arriving in one chunk', () => {
    const { events, parser } = collector();
    parser.push(
      frame({ type: 'routing', agent: 'coding', reason: 'llm', conversationId: 'c1' }) +
        frame({ type: 'token', text: 'a' }) +
        frame({ type: 'token', text: 'b' }),
    );
    expect(events).toHaveLength(3);
    expect(events[1]).toEqual({ type: 'token', text: 'a' });
  });

  it('skips malformed JSON without killing the stream', () => {
    const { events, parser } = collector();
    parser.push('event: x\ndata: {not json}\n\n');
    parser.push(frame({ type: 'token', text: 'still alive' }));
    expect(events).toEqual([{ type: 'token', text: 'still alive' }]);
  });

  it('ignores frames without data lines (comments/keepalives)', () => {
    const { events, parser } = collector();
    parser.push(': keepalive\n\n');
    expect(events).toHaveLength(0);
  });

  it('flush() drains a trailing frame missing its terminator', () => {
    const { events, parser } = collector();
    parser.push('event: done\ndata: {"type":"done","messageId":"m1","usage":{"inputTokens":1,"outputTokens":2}}');
    expect(events).toHaveLength(0); // not yet - no blank line
    parser.flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'done', messageId: 'm1' });
  });

  it('preserves token text exactly (whitespace matters for streaming)', () => {
    const { events, parser } = collector();
    parser.push(frame({ type: 'token', text: '  leading and trailing  ' }));
    expect((events[0] as { text: string }).text).toBe('  leading and trailing  ');
  });
});
