'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArtifactsPanel } from '@/components/ArtifactsPanel';
import { Composer, type ComposerHandle } from '@/components/Composer';
import { ConversationRail } from '@/components/ConversationRail';
import { MessageThread, type SiblingInfo, type ThreadMessage } from '@/components/MessageThread';
import { Folder } from 'lucide-react';
import { PipelinePanel } from '@/components/PipelinePanel';
import { SettingsModal, type SettingsTab } from '@/components/SettingsModal';
import { Topbar } from '@/components/Topbar';
import { apiFetch, ApiError } from '@/lib/api';
import { extractArtifacts } from '@/lib/artifacts';
import { useAuth } from '@/lib/auth-context';
import {
  applyEvent,
  applyEventToSteps,
  DEFAULT_AGENTS,
  idleRun,
  interruptRun,
  interruptSteps,
  startRun,
  startSteps,
  synthesizeRecord,
  type AgentMeta,
  type RunRecord,
  type RunState,
} from '@/lib/pipeline';
import {
  DEFAULT_SHORTCUTS,
  formatBinding,
  loadShortcuts,
  matchesBinding,
  saveShortcuts,
  type ShortcutMap,
} from '@/lib/shortcuts';
import { takePendingChat } from '@/lib/handoff';
import { streamChat, type ChatRequestBody } from '@/lib/sse';
import { useChatData } from '@/lib/use-chat-data';
import { defaultPath, effectiveParents, pathThrough, siblingsOf } from '@/lib/thread';
import type { ApiMessage, AttachmentPayload, Strictness } from '@/lib/types';

const STRICTNESS_KEY = 'assistant.strictness';

let localId = 0;
const nextId = () => `local-${++localId}`;

interface SendOptions {
  /** Visible path prefix to keep (edit/regenerate rewind the thread first). */
  base?: ThreadMessage[];
  /** Branch anchor for the new user message (undefined = newest branch). */
  parentMessageId?: string | null;
  /** Regenerate: re-answer this user message id instead of sending a new one. */
  regenerateOf?: string;
  /** Create the new conversation inside this project (first message only). */
  projectId?: string;
}

export default function ChatPage() {
  const { status, user, logout } = useAuth();
  const router = useRouter();

  const {
    conversations,
    setConversations,
    projects,
    loading: convsLoading,
    renameConversation: onRename,
    deleteConversation: deleteConv,
    toggleStar,
    moveConversationToProject,
  } = useChatData(status === 'authed');
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Project chosen from the composer before a new conversation exists yet. */
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  /** Full message tree of the active conversation (branch-nav source of truth). */
  const [allMessages, setAllMessages] = useState<ApiMessage[]>([]);
  /** The rendered root→leaf path. */
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [agents, setAgents] = useState<AgentMeta[]>(DEFAULT_AGENTS);
  const [run, setRun] = useState<RunState>(() => idleRun(DEFAULT_AGENTS));
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined);
  const [playback, setPlayback] = useState<RunRecord | null>(null);
  const [ephemeral, setEphemeral] = useState(false);
  const [strictness, setStrictnessState] = useState<Strictness>('balanced');
  const [shortcuts, setShortcutsState] = useState<ShortcutMap>(DEFAULT_SHORTCUTS);
  const [threadLoading, setThreadLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<ComposerHandle>(null);

  /** Composer autofocus is a desktop nicety; on touch it would pop the keyboard. */
  const focusComposer = useCallback((onlyWhenIdle = false) => {
    if (typeof window === 'undefined' || !window.matchMedia('(pointer: fine)').matches) return;
    if (onlyWhenIdle && document.activeElement !== document.body) return;
    composerRef.current?.focus();
  }, []);

  // restore the persisted answer-style + shortcut preferences
  useEffect(() => {
    const saved = localStorage.getItem(STRICTNESS_KEY);
    if (saved === 'strict' || saved === 'balanced' || saved === 'creative') setStrictnessState(saved);
    setShortcutsState(loadShortcuts());
  }, []);
  const setStrictness = (s: Strictness) => {
    setStrictnessState(s);
    localStorage.setItem(STRICTNESS_KEY, s);
  };
  const setShortcuts = (next: ShortcutMap) => {
    setShortcutsState(next);
    saveShortcuts(next);
  };

  // Route guard
  useEffect(() => {
    if (status === 'anon') router.replace('/login');
  }, [status, router]);

  // Load the agent registry (drives the pipeline canvas) once authed;
  // conversations + projects come from useChatData.
  useEffect(() => {
    if (status !== 'authed') return;
    apiFetch<{ agents: AgentMeta[] }>('/agents')
      .then((d) => {
        setAgents(d.agents);
        setRun(idleRun(d.agents));
      })
      .catch(() => {
        /* keep the DEFAULT_AGENTS mirror */
      });
    focusComposer();
  }, [status, focusComposer]);

  // One-shot intake: a message handed off from a project page's composer, or a
  // /chat?c=<convId> deep link from the history/project pages.
  const intakeRef = useRef(false);
  useEffect(() => {
    if (status !== 'authed' || intakeRef.current) return;
    intakeRef.current = true;
    const pending = takePendingChat();
    if (pending) {
      void send(pending.text, pending.attachments, {
        ...(pending.projectId ? { projectId: pending.projectId } : {}),
      });
      return;
    }
    const c = new URLSearchParams(window.location.search).get('c');
    if (c) {
      window.history.replaceState(null, '', '/chat');
      void selectConversation(c);
    }
  });

  /** ApiMessage path → thread messages, synthesizing step timelines for history. */
  const toThread = useCallback(
    (path: ApiMessage[]): ThreadMessage[] =>
      path.map((m, i, arr) => {
        if (m.role === 'user') {
          return {
            localId: m.msgId,
            msgId: m.msgId,
            role: 'user' as const,
            content: m.content,
            attachments: m.attachments,
            createdAt: m.createdAt,
          };
        }
        // history has no captured events - synthesize an approximate replay
        const prevUser = [...arr.slice(0, i)].reverse().find((p) => p.role === 'user');
        const record = synthesizeRecord(prevUser?.content ?? '', m);
        const replayed = record
          ? record.events.reduce((s, e) => applyEventToSteps(s, e.event, agents), startSteps())
          : undefined;
        const steps = replayed && record?.interrupted ? interruptSteps(replayed) : replayed;
        return {
          localId: m.msgId,
          msgId: m.msgId,
          role: 'assistant' as const,
          content: m.content,
          agentId: m.agentId,
          truncated: m.truncated,
          feedback: m.feedback,
          createdAt: m.createdAt,
          run: record ?? undefined,
          steps,
        };
      }),
    [agents],
  );

  const selectConversation = useCallback(
    async (convId: string) => {
      abortRef.current?.abort();
      setActiveId(convId);
      setEphemeral(false);
      setRailOpen(false);
      setPlayback(null);
      setPendingProjectId(null);
      setThreadLoading(true);
      try {
        const d = await apiFetch<{ messages: ApiMessage[] }>(`/conversations/${convId}/messages`);
        setAllMessages(d.messages);
        setMessages(toThread(defaultPath(d.messages)));
      } catch {
        setAllMessages([]);
        setMessages([]);
      } finally {
        setThreadLoading(false);
      }
      focusComposer();
    },
    [toThread, focusComposer],
  );

  const newChat = useCallback(
    (opts: { ephemeral?: boolean } = {}) => {
      abortRef.current?.abort();
      setActiveId(null);
      setAllMessages([]);
      setMessages([]);
      setRailOpen(false);
      setPlayback(null);
      setPendingProjectId(null);
      if (opts.ephemeral !== undefined) setEphemeral(opts.ephemeral);
      focusComposer();
    },
    [focusComposer],
  );

  function updateLast(patch: (m: ThreadMessage) => ThreadMessage) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') next[next.length - 1] = patch(last);
      return next;
    });
  }

  function replayMessage(m: ThreadMessage) {
    if (!m.run || streaming) return;
    setPlayback(m.run);
    setPipelineOpen(true);
    setArtifactsOpen(false);
  }

  async function send(text: string, attachments: AttachmentPayload[] = [], sendOpts: SendOptions = {}) {
    const opts: SendOptions = {
      ...sendOpts,
      projectId: sendOpts.projectId ?? (activeId ? undefined : pendingProjectId ?? undefined),
    };
    const base = opts.base ?? messages;
    const regenerating = Boolean(opts.regenerateOf);
    const displayText = regenerating
      ? [...base].reverse().find((m) => m.role === 'user')?.content ?? text
      : text;

    setStreaming(true);
    setPlayback(null); // a live run always takes over the panel
    const startedAt = Date.now();
    const record: RunRecord = { message: displayText, startedAt, events: [] };
    setRun(startRun(agents, displayText, startedAt));

    const userLocalId = nextId();
    const attachmentMeta = attachments.map(({ dataBase64: _b64, ...meta }) => meta);
    const sentAt = new Date().toISOString();
    setMessages([
      ...base,
      ...(regenerating
        ? []
        : [
            {
              localId: userLocalId,
              role: 'user' as const,
              content: text,
              createdAt: sentAt,
              ...(attachmentMeta.length ? { attachments: attachmentMeta } : {}),
            },
          ]),
      { localId: nextId(), role: 'assistant' as const, content: '', streaming: true, steps: startSteps(), createdAt: sentAt },
    ]);

    // Anchor for the optimistic tree update; the server resolves the same way.
    const anchorId =
      opts.parentMessageId !== undefined
        ? opts.parentMessageId
        : [...base].reverse().find((m) => m.msgId)?.msgId ?? null;

    const body: ChatRequestBody = {
      message: text,
      strictness,
      ...(ephemeral
        ? {
            ephemeral: true,
            clientHistory: base
              .filter((m) => m.content)
              .slice(-40)
              .map((m) => ({ role: m.role, content: m.content })),
          }
        : {
            ...(activeId ? { conversationId: activeId } : {}),
            ...(!activeId && opts.projectId ? { projectId: opts.projectId } : {}),
            ...(regenerating
              ? { regenerate: true, parentMessageId: opts.regenerateOf }
              : opts.parentMessageId !== undefined
                ? { parentMessageId: opts.parentMessageId }
                : {}),
          }),
      ...(attachments.length ? { attachments } : {}),
    };

    const abort = new AbortController();
    abortRef.current = abort;

    let userMsgId = opts.regenerateOf ?? '';
    let doneMsgId = '';
    let finalText = '';
    let agentId: ApiMessage['agentId'];

    try {
      await streamChat(
        body,
        (event) => {
          const at = Date.now();
          record.events.push({ event, at });
          setRun((r) => applyEvent(r, event, at));
          updateLast((m) => ({
            ...m,
            steps: applyEventToSteps(m.steps ?? startSteps(), event, agents),
          }));
          switch (event.type) {
            case 'routing':
              agentId = event.agent;
              updateLast((m) => ({ ...m, agentId: event.agent }));
              if (!regenerating && event.userMessageId) {
                userMsgId = event.userMessageId;
                setMessages((prev) =>
                  prev.map((m) => (m.localId === userLocalId ? { ...m, msgId: event.userMessageId } : m)),
                );
              }
              if (!ephemeral) {
                if (!activeId && event.conversationId) {
                  const convId = event.conversationId;
                  const agentId = event.agent;
                  setActiveId(convId);
                  setConversations((prev) => {
                    const optimistic = {
                      convId,
                      title: displayText.slice(0, 60) || attachmentMeta[0]?.name || 'New conversation',
                      ...(opts.projectId ? { projectId: opts.projectId } : {}),
                      lastMessageAt: new Date().toISOString(),
                      lastAgentId: agentId,
                    };
                    // The concurrent /conversations fetch (useChatData) may have
                    // already loaded this brand-new conversation - created early
                    // server-side before the routing event streams back - so merge
                    // in place instead of prepending a duplicate row.
                    return prev.some((c) => c.convId === convId)
                      ? prev.map((c) => (c.convId === convId ? { ...c, ...optimistic } : c))
                      : [optimistic, ...prev];
                  });
                } else if (activeId) {
                  setConversations((prev) =>
                    prev.map((c) =>
                      c.convId === activeId
                        ? { ...c, lastMessageAt: new Date().toISOString(), lastAgentId: event.agent }
                        : c,
                    ),
                  );
                }
              }
              break;
            case 'token':
              finalText += event.text;
              updateLast((m) => ({ ...m, content: m.content + event.text }));
              break;
            case 'done':
              doneMsgId = event.messageId;
              updateLast((m) => ({ ...m, streaming: false, msgId: event.messageId }));
              break;
            case 'memory':
              updateLast((m) => ({ ...m, memorySaved: event.saved }));
              break;
            case 'refusal':
              // Provider declined: its rejection text becomes the message body.
              finalText += (finalText ? '\n\n' : '') + event.message;
              updateLast((m) => ({
                ...m,
                content: m.content + (m.content ? '\n\n' : '') + event.message,
              }));
              break;
            case 'error':
              updateLast((m) => ({ ...m, streaming: false, error: event.message, truncated: m.content.length > 0 }));
              break;
          }
        },
        abort.signal,
      );
    } catch (err) {
      setRun((r) => interruptRun(r));
      if ((err as Error).name === 'AbortError') {
        updateLast((m) => ({
          ...m,
          streaming: false,
          truncated: m.content.length > 0,
          steps: m.steps ? interruptSteps(m.steps) : m.steps,
        }));
      } else {
        const message =
          err instanceof ApiError ? err.message : 'Could not reach the assistant - is the backend running?';
        updateLast((m) => ({
          ...m,
          streaming: false,
          error: message,
          steps: m.steps ? interruptSteps(m.steps) : m.steps,
        }));
        if (err instanceof ApiError && err.status === 401) {
          logout();
          router.replace('/login');
        }
      }
    } finally {
      // seal the recording and attach it to the message so its bubble can replay it
      record.endedAt = Date.now();
      const lastType = record.events[record.events.length - 1]?.event.type;
      if (lastType !== 'done' && lastType !== 'error') record.interrupted = true;
      updateLast((m) => ({ ...m, streaming: false, run: record }));

      // Mirror the persisted turn into the local tree so branch nav stays live.
      if (!ephemeral && doneMsgId) {
        const now = new Date().toISOString();
        setAllMessages((prev) => [
          ...prev,
          ...(!regenerating && userMsgId
            ? [
                {
                  msgId: userMsgId,
                  convId: activeId ?? '',
                  role: 'user' as const,
                  content: text,
                  parentId: anchorId,
                  ...(attachmentMeta.length ? { attachments: attachmentMeta } : {}),
                  createdAt: now,
                },
              ]
            : []),
          {
            msgId: doneMsgId,
            convId: activeId ?? '',
            role: 'assistant' as const,
            content: finalText,
            agentId,
            parentId: userMsgId || anchorId,
            createdAt: now,
          },
        ]);
      }
      setStreaming(false);
      abortRef.current = null;
      // Hand the keyboard back for the follow-up - unless the user moved on.
      focusComposer(true);
    }
  }

  /* ---- branching, regenerate, edit, feedback ---- */

  const siblingInfo = useCallback(
    (m: ThreadMessage): SiblingInfo | null => {
      if (!m.msgId || ephemeral) return null;
      const siblings = siblingsOf(allMessages, m.msgId);
      if (siblings.length < 2) return null;
      const index = siblings.findIndex((s) => s.msgId === m.msgId);
      return index === -1 ? null : { index: index + 1, count: siblings.length };
    },
    [allMessages, ephemeral],
  );

  function onSiblingNav(m: ThreadMessage, direction: -1 | 1) {
    if (!m.msgId) return;
    const siblings = siblingsOf(allMessages, m.msgId);
    const index = siblings.findIndex((s) => s.msgId === m.msgId);
    const target = siblings[index + direction];
    if (!target) return;
    setMessages(toThread(pathThrough(allMessages, target.msgId)));
  }

  function onRegenerate(m: ThreadMessage) {
    if (streaming) return;
    const index = messages.findIndex((x) => x.localId === m.localId);
    if (index === -1) return;
    const userMsg = [...messages.slice(0, index)].reverse().find((x) => x.role === 'user');
    if (!userMsg) return;
    const base = messages.slice(0, index);
    if (userMsg.msgId && !ephemeral) {
      void send('', [], { base, regenerateOf: userMsg.msgId });
    } else {
      // No server id (ephemeral or failed turn): resend the text as a new turn.
      void send(userMsg.content, [], { base: messages.slice(0, messages.indexOf(userMsg)) });
    }
  }

  function onEditSubmit(m: ThreadMessage, newText: string) {
    if (streaming || !m.msgId) return;
    const index = messages.findIndex((x) => x.localId === m.localId);
    if (index === -1) return;
    const parent = effectiveParents(allMessages).get(m.msgId) ?? null;
    void send(newText, [], { base: messages.slice(0, index), parentMessageId: parent });
  }

  function onFeedback(m: ThreadMessage, rating: 'up' | 'down' | null, comment?: string) {
    if (!m.msgId || !activeId) return;
    setMessages((prev) =>
      prev.map((x) => (x.localId === m.localId ? { ...x, feedback: rating ?? undefined } : x)),
    );
    setAllMessages((prev) =>
      prev.map((x) => (x.msgId === m.msgId ? { ...x, feedback: rating ?? undefined } : x)),
    );
    apiFetch(`/conversations/${activeId}/messages/${m.msgId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ rating, ...(comment ? { comment } : {}) }),
    }).catch(() => {
      /* feedback is best-effort - never interrupt the flow */
    });
  }

  /* ---- history & project management (data ops live in useChatData) ---- */

  function onDelete(convId: string) {
    deleteConv(convId);
    if (convId === activeId) newChat();
  }

  /** Composer's "Add to project": moves the live chat, or stages the choice for the first message. */
  function onComposerSelectProject(projectId: string | null) {
    if (activeId) moveConversationToProject(activeId, projectId);
    else setPendingProjectId(projectId);
  }

  function openConnectorSettings() {
    setSettingsInitialTab('connectors');
    setSettingsOpen(true);
  }

  /* ---- artifacts ---- */

  const artifacts = useMemo(
    () =>
      extractArtifacts(
        messages.map((m) => ({ key: m.msgId ?? m.localId, role: m.role, content: m.content })),
      ),
    [messages],
  );

  /* ---- keyboard shortcuts (rebindable in Settings → Shortcuts) ---- */

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (matchesBinding(e, shortcuts.search)) {
        e.preventDefault();
        setRailOpen(true);
        searchRef.current?.focus();
      } else if (matchesBinding(e, shortcuts.newChat)) {
        e.preventDefault();
        newChat();
      } else if (matchesBinding(e, shortcuts.incognito)) {
        e.preventDefault();
        newChat({ ephemeral: !ephemeral });
      } else if (e.key === 'Escape' && abortRef.current) {
        abortRef.current.abort();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ephemeral, newChat, shortcuts]);

  const shortcutLabels = useMemo(
    () => ({
      search: formatBinding(shortcuts.search),
      newChat: formatBinding(shortcuts.newChat),
      incognito: formatBinding(shortcuts.incognito),
    }),
    [shortcuts],
  );

  if (status !== 'authed' || !user) return null;

  const threadKey = activeId ?? (ephemeral ? 'incognito' : 'new');
  const activeProjectOfChat = (() => {
    const pid = conversations.find((c) => c.convId === activeId)?.projectId;
    return pid ? projects.find((p) => p.projectId === pid) ?? null : null;
  })();
  const composerProjectId = activeId
    ? conversations.find((c) => c.convId === activeId)?.projectId ?? null
    : pendingProjectId;

  return (
    <div className="app">
      <Topbar
        ephemeral={ephemeral}
        artifactCount={artifacts.length}
        incognitoShortcutLabel={shortcutLabels.incognito}
        onToggleRail={() => setRailOpen((o) => !o)}
        onTogglePipeline={() => {
          setPipelineOpen((o) => !o);
          setArtifactsOpen(false);
        }}
        onToggleArtifacts={() => {
          setArtifactsOpen((o) => !o);
          setPipelineOpen(false);
        }}
        onToggleEphemeral={() => newChat({ ephemeral: !ephemeral })}
        onOpenSettings={() => {
          setSettingsInitialTab(undefined);
          setSettingsOpen(true);
        }}
      />
      <div className="chat-body">
        {railOpen && <div className="scrim scrim-rail" onClick={() => setRailOpen(false)} aria-hidden="true" />}
        {(pipelineOpen || artifactsOpen) && (
          <div
            className="scrim scrim-panel"
            onClick={() => {
              setPipelineOpen(false);
              setArtifactsOpen(false);
            }}
            aria-hidden="true"
          />
        )}
        <ConversationRail
          ref={searchRef}
          conversations={conversations}
          projects={projects}
          activeId={activeId}
          open={railOpen}
          email={user.email}
          loading={convsLoading}
          searchShortcutLabel={shortcutLabels.search}
          onSelect={selectConversation}
          onNew={() => newChat()}
          onOpenChats={() => router.push('/chats')}
          onOpenProjects={() => router.push('/projects')}
          onRename={onRename}
          onDelete={onDelete}
          onStar={toggleStar}
          onLogout={() => { logout(); router.replace('/login'); }}
        />
        <main className="chat-pane">
          {activeProjectOfChat && (
            <button
              className="project-crumb"
              onClick={() => router.push(`/projects/${activeProjectOfChat.projectId}`)}
              title={`Open project ${activeProjectOfChat.name}`}
            >
              <Folder size={12} /> {activeProjectOfChat.name}
            </button>
          )}
          <MessageThread
            messages={messages}
            streaming={streaming}
            ephemeral={ephemeral}
            threadKey={threadKey}
            loading={threadLoading}
            shortcutHints={{ search: shortcutLabels.search, newChat: shortcutLabels.newChat }}
            onReplay={replayMessage}
            siblingInfo={siblingInfo}
            onSiblingNav={onSiblingNav}
            onRegenerate={onRegenerate}
            onEditSubmit={onEditSubmit}
            onFeedback={onFeedback}
          />
          {/* Hands-free voice mode is disabled in all browsers — omit onVoiceMode so
              the Composer never shows the entry point. (VoiceMode.tsx is kept for
              easy re-enable: pass onVoiceMode + render <VoiceMode> when voiceOpen.) */}
          <Composer
            ref={composerRef}
            disabled={streaming}
            streaming={streaming}
            strictness={strictness}
            ephemeral={ephemeral}
            draftKey={threadKey}
            projects={projects}
            currentProjectId={composerProjectId}
            onSelectProject={onComposerSelectProject}
            onOpenConnectors={openConnectorSettings}
            onManageProjects={() => router.push('/projects')}
            onStrictnessChange={setStrictness}
            onSend={(text, attachments) => void send(text, attachments)}
            onStop={() => abortRef.current?.abort()}
          />
        </main>
        {artifactsOpen ? (
          <ArtifactsPanel artifacts={artifacts} open={artifactsOpen} onClose={() => setArtifactsOpen(false)} />
        ) : (
          <PipelinePanel
            agents={agents}
            run={run}
            open={pipelineOpen}
            onClose={() => setPipelineOpen(false)}
            playback={playback}
            onExitPlayback={() => setPlayback(null)}
          />
        )}
      </div>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        shortcuts={shortcuts}
        onShortcutsChange={setShortcuts}
        initialTab={settingsInitialTab}
        onConversationsCleared={() => {
          setConversations([]);
          newChat();
        }}
      />
    </div>
  );
}
