'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api';
import type { Conversation, Project } from './types';

/**
 * Conversations + projects shared by every page that renders the sidebar
 * (chat, chat history, project pages). Mutations are optimistic: state updates
 * immediately, the API call follows, and the list self-corrects on next load.
 */
export function useChatData(enabled: boolean) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    apiFetch<{ conversations: Conversation[] }>('/conversations')
      .then((d) => setConversations(d.conversations))
      .catch(() => setConversations([]))
      .finally(() => setLoading(false));
    apiFetch<{ projects: Project[] }>('/projects')
      .then((d) => setProjects(d.projects))
      .catch(() => setProjects([]));
  }, [enabled]);

  const renameConversation = useCallback((convId: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.convId === convId ? { ...c, title } : c)));
    apiFetch(`/conversations/${convId}`, { method: 'PATCH', body: JSON.stringify({ title }) }).catch(
      () => {
        /* optimistic; list refreshes on next load */
      },
    );
  }, []);

  const deleteConversation = useCallback((convId: string) => {
    setConversations((prev) => prev.filter((c) => c.convId !== convId));
    apiFetch(`/conversations/${convId}`, { method: 'DELETE' }).catch(() => {
      /* optimistic */
    });
  }, []);

  const toggleStar = useCallback((convId: string) => {
    setConversations((prev) => {
      const starred = !prev.find((c) => c.convId === convId)?.starred;
      apiFetch(`/conversations/${convId}`, {
        method: 'PATCH',
        body: JSON.stringify({ starred }),
      }).catch(() => {
        /* optimistic */
      });
      return prev.map((c) => (c.convId === convId ? { ...c, starred: starred || undefined } : c));
    });
  }, []);

  /** Create (editing = null) or update a project; returns the saved record. */
  const saveProject = useCallback(
    async (
      editing: Project | null,
      draft: { name: string; description: string; instructions: string },
    ): Promise<Project> => {
      if (editing) {
        const d = await apiFetch<{ project: Project }>(`/projects/${editing.projectId}`, {
          method: 'PATCH',
          body: JSON.stringify(draft),
        });
        setProjects((prev) => prev.map((p) => (p.projectId === d.project.projectId ? d.project : p)));
        return d.project;
      }
      const d = await apiFetch<{ project: Project }>('/projects', {
        method: 'POST',
        body: JSON.stringify(draft),
      });
      setProjects((prev) => [d.project, ...prev]);
      return d.project;
    },
    [],
  );

  /** Moves a conversation into a project, or out of one when projectId is null. */
  const moveConversationToProject = useCallback((convId: string, projectId: string | null) => {
    setConversations((prev) =>
      prev.map((c) => (c.convId === convId ? { ...c, projectId: projectId ?? undefined } : c)),
    );
    apiFetch(`/conversations/${convId}`, {
      method: 'PATCH',
      body: JSON.stringify({ projectId }),
    }).catch(() => {
      /* optimistic; list refreshes on next load */
    });
  }, []);

  const deleteProject = useCallback((projectId: string) => {
    setProjects((prev) => prev.filter((p) => p.projectId !== projectId));
    // Chats survive server-side (detached), so mirror that locally.
    setConversations((prev) =>
      prev.map((c) => (c.projectId === projectId ? { ...c, projectId: undefined } : c)),
    );
    apiFetch(`/projects/${projectId}`, { method: 'DELETE' }).catch(() => {
      /* optimistic */
    });
  }, []);

  return {
    conversations,
    setConversations,
    projects,
    loading,
    renameConversation,
    deleteConversation,
    toggleStar,
    moveConversationToProject,
    saveProject,
    deleteProject,
  };
}
