import { describe, expect, it } from 'vitest';
import { chunkForSpeech, textForSpeech } from '@/lib/speech';

describe('textForSpeech', () => {
  it('drops code fences instead of reading them aloud', () => {
    const out = textForSpeech('Here you go:\n```js\nconst x = 1;\n```\nDone.');
    expect(out).not.toContain('const x');
    expect(out).toContain('code block');
    expect(out).toContain('Done.');
  });

  it('keeps link and inline-code text but removes the markup', () => {
    expect(textForSpeech('See [the docs](https://x.com) and `run()`.')).toBe(
      'See the docs and run().',
    );
  });

  it('strips heading, emphasis, and table markers', () => {
    expect(textForSpeech('# Title\n**bold** and _italic_')).toBe('Title bold and italic');
  });
});

describe('chunkForSpeech', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkForSpeech('Hello there.')).toEqual(['Hello there.']);
  });

  it('splits long text on sentence boundaries under the cap', () => {
    const sentence = 'This is a fairly long sentence that carries some weight. ';
    const chunks = chunkForSpeech(sentence.repeat(6), 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120 + sentence.length);
    // No content is lost across the split.
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(
      sentence.repeat(6).replace(/\s+/g, ' ').trim(),
    );
  });
});
