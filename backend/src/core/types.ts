import type { ErrorCode } from './errors';

export type AgentId = 'generic' | 'coding' | 'financial';

export type Role = 'user' | 'assistant';

/** User-selected answer style: maps to model temperature + a prompt directive. */
export type Strictness = 'strict' | 'balanced' | 'creative';

export interface ToolCallSummary {
  tool: string;
  ok: boolean;
  summary: string;
}

/**
 * Attachment metadata persisted with a user message. The raw bytes are NOT
 * stored (DynamoDB items cap at 400KB): images inform the turn they were sent
 * in; text attachments are inlined into the prompt. Production: S3 + presigned
 * URLs (docs/LLD.md).
 */
export interface AttachmentMeta {
  name: string;
  mediaType: string;
  kind: 'image' | 'text';
  /** decoded size in bytes */
  size: number;
}

export interface Message {
  msgId: string;
  convId: string;
  role: Role;
  content: string;
  agentId?: AgentId;
  toolCalls?: ToolCallSummary[];
  /** true when the stream died after partial output was emitted */
  truncated?: boolean;
  /**
   * Branching: the message this one replies to (null = conversation root).
   * Absent on messages that predate branching - those are treated as a linear
   * chain in createdAt order.
   */
  parentId?: string | null;
  /** Thumbs rating left by the user (assistant messages only). */
  feedback?: 'up' | 'down';
  feedbackComment?: string;
  attachments?: AttachmentMeta[];
  createdAt: string; // ISO
}

export interface ToolResult {
  ok: boolean;
  /** Fed back to the model verbatim; errors travel here too ("search unavailable: ...") */
  content: string;
}

export interface ChatContext {
  userId: string;
  conversationId: string;
  history: Message[];
  /** Client disconnect → abort downstream LLM/tool work */
  signal: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema for Bedrock tool_use
  execute(input: unknown, ctx: ChatContext): Promise<ToolResult>;
}

export interface Agent {
  id: AgentId;
  displayName: string;
  /** Used by the router classifier prompt - describe when to pick this agent */
  description: string;
  systemPrompt: string;
  modelId: string;
  tools: Tool[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Every event that can travel down the SSE stream to the client. */
export type StreamEvent =
  | {
      type: 'routing';
      agent: AgentId;
      reason: 'llm' | 'fallback';
      conversationId: string;
      /** id of the user message this run answers ('' on regenerate/ephemeral runs) */
      userMessageId: string;
    }
  | { type: 'token'; text: string }
  | { type: 'tool_start'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; ok: boolean; summary: string }
  | { type: 'done'; messageId: string; usage: Usage }
  /** Cross-session memory picked up new facts this turn (transparency chip in the UI). */
  | { type: 'memory'; saved: string[] }
  /** The LLM provider declined the request; `message` is user-facing and includes the provider's own rejection text when available. */
  | { type: 'refusal'; provider: string; category?: string; message: string }
  | { type: 'error'; code: ErrorCode; message: string };
