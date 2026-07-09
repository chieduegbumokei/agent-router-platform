import type { AgentId, Message } from '../core/types';

export interface UserRecord {
  userId: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface RefreshTokenRecord {
  userId: string;
  tokenId: string;
  familyId: string;
  /** sha256 of the token secret - the raw secret is never stored */
  secretHash: string;
  /** epoch seconds (doubles as the DynamoDB TTL attribute) */
  expiresAt: number;
  /** set when rotated; presenting a rotated token = reuse → revoke family */
  rotatedTo?: string;
  revoked?: boolean;
}

export interface ConversationRecord {
  convId: string;
  userId: string;
  title: string;
  /** Project the conversation lives in; absent = ungrouped chat. */
  projectId?: string;
  /** Pinned to the sidebar's Starred section. */
  starred?: boolean;
  createdAt: string;
  lastMessageAt: string;
  lastAgentId?: AgentId;
}

/**
 * A project (Claude.ai-style): groups conversations and carries instructions
 * injected into the system prompt of every chat inside it.
 */
export interface ProjectRecord {
  projectId: string;
  userId: string;
  name: string;
  description: string;
  /** Free-text project instructions prepended to every chat in the project. */
  instructions: string;
  createdAt: string;
  updatedAt: string;
}

/** Per-user preferences: custom instructions + privacy toggles. */
export interface UserSettingsRecord {
  userId: string;
  /** Free-text persona/instructions injected into every agent's system prompt. */
  customInstructions: string;
  /** Master switch for cross-session memory (extraction AND injection). */
  memoryEnabled: boolean;
  updatedAt: string;
}

export const DEFAULT_SETTINGS = (userId: string): UserSettingsRecord => ({
  userId,
  customInstructions: '',
  memoryEnabled: true,
  updatedAt: new Date(0).toISOString(),
});

/** One durable fact remembered about the user across conversations. */
export interface MemoryRecord {
  memId: string;
  userId: string;
  content: string;
  /** conversation the fact was learned in (provenance shown in settings) */
  sourceConvId?: string;
  createdAt: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A user-connected MCP server (Streamable HTTP transport). */
export interface McpServerRecord {
  serverId: string;
  userId: string;
  name: string;
  url: string;
  /** Bearer token sent as Authorization header - never returned to the client. */
  authToken?: string;
  enabled: boolean;
  /** Tool snapshot from the last successful tools/list (refreshed on demand). */
  tools: McpToolInfo[];
  status: 'ok' | 'error';
  lastError?: string;
  createdAt: string;
  lastCheckedAt: string;
}

/**
 * Storage contract. Two implementations: memory (zero-setup dev/tests) and
 * dynamo (DynamoDB Local or AWS). All conversation reads are keyed by userId
 * so ownership is enforced at the data layer, not as an afterthought.
 */
export interface Store {
  // users
  createUser(user: UserRecord): Promise<void>; // throws CONFLICT if email exists
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(userId: string): Promise<UserRecord | null>;

  // refresh tokens
  putRefreshToken(rec: RefreshTokenRecord): Promise<void>;
  getRefreshToken(userId: string, tokenId: string): Promise<RefreshTokenRecord | null>;
  /** Atomic: returns false if the token was already rotated (lost a concurrent race). */
  markRotated(userId: string, tokenId: string, rotatedTo: string): Promise<boolean>;
  revokeFamily(userId: string, familyId: string): Promise<void>;

  // conversations
  createConversation(conv: ConversationRecord): Promise<void>;
  getConversation(userId: string, convId: string): Promise<ConversationRecord | null>;
  listConversations(userId: string): Promise<ConversationRecord[]>; // newest first
  touchConversation(
    userId: string,
    convId: string,
    patch: { lastMessageAt: string; lastAgentId?: AgentId },
  ): Promise<void>;
  renameConversation(userId: string, convId: string, title: string): Promise<void>;
  /** Moves the conversation into a project (null = detach). */
  setConversationProject(userId: string, convId: string, projectId: string | null): Promise<void>;
  setConversationStarred(userId: string, convId: string, starred: boolean): Promise<void>;
  /** Removes the conversation AND all of its messages. */
  deleteConversation(userId: string, convId: string): Promise<void>;

  // projects
  putProject(project: ProjectRecord): Promise<void>; // create or replace
  getProject(userId: string, projectId: string): Promise<ProjectRecord | null>;
  listProjects(userId: string): Promise<ProjectRecord[]>; // newest first
  /** Removes the project and detaches (never deletes) its conversations. */
  deleteProject(userId: string, projectId: string): Promise<void>;

  // messages
  addMessage(msg: Message): Promise<void>;
  listMessages(convId: string, limit: number): Promise<Message[]>; // oldest → newest
  /** Feedback patch; rating null clears it. No-op when the message is missing. */
  updateMessageFeedback(
    convId: string,
    msgId: string,
    patch: { feedback: 'up' | 'down' | null; feedbackComment?: string },
  ): Promise<void>;

  // user settings (personalization + privacy)
  getUserSettings(userId: string): Promise<UserSettingsRecord | null>;
  putUserSettings(settings: UserSettingsRecord): Promise<void>;

  // cross-session memory
  putMemory(mem: MemoryRecord): Promise<void>;
  listMemories(userId: string): Promise<MemoryRecord[]>; // newest first
  deleteMemory(userId: string, memId: string): Promise<void>;
  deleteAllMemories(userId: string): Promise<void>;

  // MCP connectors
  putMcpServer(rec: McpServerRecord): Promise<void>; // create or replace
  getMcpServer(userId: string, serverId: string): Promise<McpServerRecord | null>;
  listMcpServers(userId: string): Promise<McpServerRecord[]>;
  deleteMcpServer(userId: string, serverId: string): Promise<void>;
}
