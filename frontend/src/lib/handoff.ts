import type { AttachmentPayload } from './types';

/**
 * One-shot in-memory handoff for a message composed outside the chat page
 * (e.g. the project page's composer). Client-side navigation keeps the JS
 * context alive, so the chat page picks it up on mount and sends it.
 */
export interface PendingChat {
  text: string;
  attachments: AttachmentPayload[];
  /** Project the new conversation should be created in. */
  projectId?: string;
}

let pending: PendingChat | null = null;

export function setPendingChat(p: PendingChat): void {
  pending = p;
}

export function takePendingChat(): PendingChat | null {
  const p = pending;
  pending = null;
  return p;
}
