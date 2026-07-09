/**
 * Artifacts: substantial fenced code blocks from assistant messages, collected
 * into the side panel so long outputs live outside the chat scrollback and
 * update in place while streaming.
 */

export interface Artifact {
  /** stable per conversation: `<messageKey>#<block index>` */
  id: string;
  language: string;
  code: string;
  title: string;
  messageKey: string;
}

const FENCE = /```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
const MIN_LINES = 6;
const MIN_CHARS = 240;

const EXT: Record<string, string> = {
  javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
  python: 'py', py: 'py', java: 'java', csharp: 'cs', go: 'go', rust: 'rs', ruby: 'rb',
  html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml', sql: 'sql',
  bash: 'sh', sh: 'sh', shell: 'sh',
};

export function artifactFileName(a: Artifact): string {
  return `artifact-${a.id.replace(/[^\w-]/g, '_')}.${EXT[a.language] ?? 'txt'}`;
}

/** Extract from one message's markdown. `open` fences count while streaming. */
export function extractFromContent(content: string, messageKey: string): Artifact[] {
  const artifacts: Artifact[] = [];
  let match: RegExpExecArray | null;
  let index = 0;
  FENCE.lastIndex = 0;
  while ((match = FENCE.exec(content)) !== null) {
    const language = (match[1] || 'text').toLowerCase();
    const code = match[2]!.replace(/\s+$/, '');
    const lines = code.split('\n').length;
    if (lines >= MIN_LINES || code.length >= MIN_CHARS) {
      artifacts.push({
        id: `${messageKey}#${index}`,
        language,
        code,
        title: `${language} · ${lines} lines`,
        messageKey,
      });
    }
    index++;
  }
  return artifacts;
}

export function extractArtifacts(
  messages: Array<{ key: string; role: 'user' | 'assistant'; content: string }>,
): Artifact[] {
  return messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => extractFromContent(m.content, m.key));
}
