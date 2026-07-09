import { CHAT_URL, getAccessToken, refreshSession, ApiError } from './api';
import type { AttachmentPayload, StreamEvent } from './types';

export interface ChatRequestBody {
  conversationId?: string;
  /** Start the new conversation inside this project (ignored with conversationId). */
  projectId?: string;
  message: string;
  strictness?: string;
  /** Branch anchor (edit); null = new root branch. Omit to append to the newest branch. */
  parentMessageId?: string | null;
  /** Re-answer the user message named by parentMessageId (no new user message). */
  regenerate?: boolean;
  /** Incognito: server persists nothing and memory stays untouched. */
  ephemeral?: boolean;
  /** Ephemeral chats supply their own history (server has none). */
  clientHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  attachments?: AttachmentPayload[];
}

/**
 * Parses an SSE byte stream into events. Exported separately from the network
 * call so it is unit-testable: handles frames split across chunks, multiple
 * frames per chunk, and multi-line data.
 */
export function createSseParser(onEvent: (event: StreamEvent) => void) {
  let buffer = '';

  const processFrame = (frame: string) => {
    const dataLines = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) return;
    try {
      onEvent(JSON.parse(dataLines.join('\n')) as StreamEvent);
    } catch {
      // malformed frame - skip rather than kill the stream
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        processFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    },
    flush() {
      if (buffer.trim()) processFrame(buffer);
      buffer = '';
    },
  };
}

/**
 * POST /chat and stream events. Native EventSource cannot POST or send an
 * Authorization header, so this reads the fetch body as a stream.
 * Retries exactly once on 401 via silent refresh (matching apiFetch).
 */
export async function streamChat(
  body: ChatRequestBody,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const attempt = () =>
    fetch(`${CHAT_URL}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${getAccessToken()}`,
      },
      body: JSON.stringify(body),
      signal,
    });

  let res = await attempt();
  if (res.status === 401) {
    const user = await refreshSession();
    if (!user) throw new ApiError(401, 'AUTH_TOKEN_EXPIRED', 'Session expired');
    res = await attempt();
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    const err = (data as { error?: { code: string; message: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'INTERNAL', err?.message ?? 'Chat request failed');
  }

  const parser = createSseParser(onEvent);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.flush();
}
