import { describe, expect, it } from 'vitest';
import { artifactFileName, extractArtifacts, extractFromContent } from '../src/lib/artifacts';

const bigJs = Array.from({ length: 8 }, (_, i) => `console.log(${i});`).join('\n');

describe('artifact extraction', () => {
  it('collects substantial fenced blocks from assistant messages only', () => {
    const artifacts = extractArtifacts([
      { key: 'u1', role: 'user', content: `\`\`\`js\n${bigJs}\n\`\`\`` },
      { key: 'a1', role: 'assistant', content: `Here you go:\n\`\`\`javascript\n${bigJs}\n\`\`\`` },
    ]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ id: 'a1#0', language: 'javascript', messageKey: 'a1' });
    expect(artifacts[0]!.code).toBe(bigJs);
  });

  it('ignores short inline snippets but keeps long one-liners', () => {
    expect(extractFromContent('```js\nconsole.log(1)\n```', 'a1')).toHaveLength(0);
    const long = `const x = '${'y'.repeat(300)}';`;
    expect(extractFromContent(`\`\`\`js\n${long}\n\`\`\``, 'a1')).toHaveLength(1);
  });

  it('captures a still-streaming open fence so the panel updates live', () => {
    const artifacts = extractFromContent(`\`\`\`python\n${bigJs}`, 'a1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.language).toBe('python');
  });

  it('indexes multiple blocks per message and defaults the language', () => {
    const artifacts = extractFromContent(`\`\`\`\n${bigJs}\n\`\`\`\ntext\n\`\`\`sql\n${bigJs}\n\`\`\``, 'a2');
    expect(artifacts.map((a) => a.id)).toEqual(['a2#0', 'a2#1']);
    expect(artifacts[0]!.language).toBe('text');
    expect(artifactFileName(artifacts[1]!)).toBe('artifact-a2_1.sql');
  });
});
