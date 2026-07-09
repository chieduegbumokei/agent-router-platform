export type AgentId = 'generic' | 'coding' | 'financial';

export type Strictness = 'strict' | 'balanced' | 'creative';

export const STRICTNESS_LABELS: Record<Strictness, { label: string; hint: string }> = {
  strict: { label: 'Strict', hint: 'Precise, factual, no speculation (low temperature)' },
  balanced: { label: 'Balanced', hint: 'Default: helpful and natural' },
  creative: { label: 'Creative', hint: 'Explores ideas, labeled speculation (high temperature)' },
};

export interface ToolCallSummary {
  tool: string;
  ok: boolean;
  summary: string;
}

export interface AttachmentMeta {
  name: string;
  mediaType: string;
  kind: 'image' | 'text';
  size: number;
}

/** Attachment payload sent with a chat request (base64, no data-URL prefix). */
export interface AttachmentPayload extends AttachmentMeta {
  dataBase64: string;
}

export interface ApiMessage {
  msgId: string;
  convId: string;
  role: 'user' | 'assistant';
  content: string;
  agentId?: AgentId;
  toolCalls?: ToolCallSummary[];
  truncated?: boolean;
  /** Branch pointer; absent on legacy messages (linear order applies). */
  parentId?: string | null;
  feedback?: 'up' | 'down';
  attachments?: AttachmentMeta[];
  createdAt: string;
}

export interface Conversation {
  convId: string;
  title: string;
  /** Project the conversation lives in; absent = ungrouped chat. */
  projectId?: string;
  /** Pinned to the sidebar's Starred section. */
  starred?: boolean;
  lastMessageAt: string;
  lastAgentId?: AgentId;
}

/** A project: groups conversations and carries shared instructions. */
export interface Project {
  projectId: string;
  name: string;
  description: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  convId: string;
  title: string;
  matchedIn: 'title' | 'message';
  snippet?: string;
  lastMessageAt: string;
}

export interface UserSettings {
  customInstructions: string;
  memoryEnabled: boolean;
}

export interface MemoryItem {
  memId: string;
  content: string;
  sourceConvId?: string;
  createdAt: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpServer {
  serverId: string;
  name: string;
  url: string;
  enabled: boolean;
  tools: McpToolInfo[];
  status: 'ok' | 'error';
  lastError?: string;
  hasAuth: boolean;
  createdAt: string;
  lastCheckedAt: string;
}

export interface SessionUser {
  userId: string;
  email: string;
}

/** Mirrors backend StreamEvent (backend/src/core/types.ts). */
export type StreamEvent =
  | {
      type: 'routing';
      agent: AgentId;
      reason: 'llm' | 'fallback';
      conversationId: string;
      userMessageId: string;
    }
  | { type: 'token'; text: string }
  | { type: 'tool_start'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; ok: boolean; summary: string }
  | { type: 'done'; messageId: string; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'memory'; saved: string[] }
  | { type: 'refusal'; provider: string; category?: string; message: string }
  | { type: 'error'; code: string; message: string };

export const AGENT_LABELS: Record<AgentId, string> = {
  generic: 'Generic Agent',
  coding: 'Coding Agent',
  financial: 'Financial Advisor',
};
