import { AppError } from '../core/errors';
import type { Message } from '../core/types';
import type {
  ConversationRecord,
  McpServerRecord,
  MemoryRecord,
  ProjectRecord,
  RefreshTokenRecord,
  Store,
  UserRecord,
  UserSettingsRecord,
} from './types';

/** In-memory Store - zero-setup dev and unit tests. Same contract as Dynamo. */
export function createMemoryStore(): Store {
  const usersById = new Map<string, UserRecord>();
  const usersByEmail = new Map<string, UserRecord>();
  const refreshTokens = new Map<string, RefreshTokenRecord>(); // `${userId}/${tokenId}`
  const conversations = new Map<string, ConversationRecord>(); // `${userId}/${convId}`
  const messages = new Map<string, Message[]>(); // convId → ordered list
  const settings = new Map<string, UserSettingsRecord>(); // userId
  const memories = new Map<string, MemoryRecord[]>(); // userId → newest first
  const mcpServers = new Map<string, McpServerRecord>(); // `${userId}/${serverId}`
  const projects = new Map<string, ProjectRecord>(); // `${userId}/${projectId}`

  return {
    async createUser(user) {
      if (usersByEmail.has(user.email)) {
        throw new AppError('CONFLICT', 409, 'Email already registered');
      }
      usersById.set(user.userId, user);
      usersByEmail.set(user.email, user);
    },
    async getUserByEmail(email) {
      return usersByEmail.get(email) ?? null;
    },
    async getUserById(userId) {
      return usersById.get(userId) ?? null;
    },

    async putRefreshToken(rec) {
      refreshTokens.set(`${rec.userId}/${rec.tokenId}`, { ...rec });
    },
    async getRefreshToken(userId, tokenId) {
      const rec = refreshTokens.get(`${userId}/${tokenId}`);
      return rec ? { ...rec } : null;
    },
    async markRotated(userId, tokenId, rotatedTo) {
      const rec = refreshTokens.get(`${userId}/${tokenId}`);
      if (!rec || rec.rotatedTo) return false;
      rec.rotatedTo = rotatedTo;
      return true;
    },
    async revokeFamily(userId, familyId) {
      for (const rec of refreshTokens.values()) {
        if (rec.userId === userId && rec.familyId === familyId) rec.revoked = true;
      }
    },

    async createConversation(conv) {
      conversations.set(`${conv.userId}/${conv.convId}`, { ...conv });
    },
    async getConversation(userId, convId) {
      const conv = conversations.get(`${userId}/${convId}`);
      return conv ? { ...conv } : null;
    },
    async listConversations(userId) {
      return [...conversations.values()]
        .filter((c) => c.userId === userId)
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    },
    async touchConversation(userId, convId, patch) {
      const conv = conversations.get(`${userId}/${convId}`);
      if (conv) Object.assign(conv, patch);
    },
    async renameConversation(userId, convId, title) {
      const conv = conversations.get(`${userId}/${convId}`);
      if (conv) conv.title = title;
    },
    async setConversationProject(userId, convId, projectId) {
      const conv = conversations.get(`${userId}/${convId}`);
      if (!conv) return;
      if (projectId === null) delete conv.projectId;
      else conv.projectId = projectId;
    },
    async setConversationStarred(userId, convId, starred) {
      const conv = conversations.get(`${userId}/${convId}`);
      if (!conv) return;
      if (starred) conv.starred = true;
      else delete conv.starred;
    },
    async deleteConversation(userId, convId) {
      if (conversations.delete(`${userId}/${convId}`)) messages.delete(convId);
    },

    async putProject(project) {
      projects.set(`${project.userId}/${project.projectId}`, { ...project });
    },
    async getProject(userId, projectId) {
      const project = projects.get(`${userId}/${projectId}`);
      return project ? { ...project } : null;
    },
    async listProjects(userId) {
      return [...projects.values()]
        .filter((p) => p.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((p) => ({ ...p }));
    },
    async deleteProject(userId, projectId) {
      projects.delete(`${userId}/${projectId}`);
      for (const conv of conversations.values()) {
        if (conv.userId === userId && conv.projectId === projectId) delete conv.projectId;
      }
    },

    async addMessage(msg) {
      const list = messages.get(msg.convId) ?? [];
      list.push({ ...msg });
      messages.set(msg.convId, list);
    },
    async listMessages(convId, limit) {
      const list = messages.get(convId) ?? [];
      return list.slice(-limit).map((m) => ({ ...m }));
    },
    async updateMessageFeedback(convId, msgId, patch) {
      const msg = (messages.get(convId) ?? []).find((m) => m.msgId === msgId);
      if (!msg) return;
      if (patch.feedback === null) {
        delete msg.feedback;
        delete msg.feedbackComment;
      } else {
        msg.feedback = patch.feedback;
        if (patch.feedbackComment !== undefined) msg.feedbackComment = patch.feedbackComment;
      }
    },

    async getUserSettings(userId) {
      const rec = settings.get(userId);
      return rec ? { ...rec } : null;
    },
    async putUserSettings(rec) {
      settings.set(rec.userId, { ...rec });
    },

    async putMemory(mem) {
      const list = memories.get(mem.userId) ?? [];
      list.unshift({ ...mem });
      memories.set(mem.userId, list);
    },
    async listMemories(userId) {
      return (memories.get(userId) ?? []).map((m) => ({ ...m }));
    },
    async deleteMemory(userId, memId) {
      memories.set(userId, (memories.get(userId) ?? []).filter((m) => m.memId !== memId));
    },
    async deleteAllMemories(userId) {
      memories.delete(userId);
    },

    async putMcpServer(rec) {
      mcpServers.set(`${rec.userId}/${rec.serverId}`, { ...rec });
    },
    async getMcpServer(userId, serverId) {
      const rec = mcpServers.get(`${userId}/${serverId}`);
      return rec ? { ...rec } : null;
    },
    async listMcpServers(userId) {
      return [...mcpServers.values()]
        .filter((s) => s.userId === userId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((s) => ({ ...s }));
    },
    async deleteMcpServer(userId, serverId) {
      mcpServers.delete(`${userId}/${serverId}`);
    },
  };
}
