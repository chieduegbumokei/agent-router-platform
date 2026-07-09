'use client';

import {
  ArrowDown,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ghost,
  GitBranch,
  Loader2,
  MessagesSquare,
  Paperclip,
  Pencil,
  PenLine,
  Play,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AGENT_LABELS, type AgentId, type AttachmentMeta } from '@/lib/types';
import type { ChatStep, RunRecord } from '@/lib/pipeline';
import { Markdown } from './Markdown';

export interface ThreadMessage {
  localId: string;
  /** Server id once known (history load, or the routing/done stream events). */
  msgId?: string;
  role: 'user' | 'assistant';
  content: string;
  agentId?: AgentId;
  steps?: ChatStep[];
  run?: RunRecord;
  streaming?: boolean;
  truncated?: boolean;
  error?: string;
  feedback?: 'up' | 'down';
  attachments?: AttachmentMeta[];
  /** Facts the memory system saved from this turn (transparency chip). */
  memorySaved?: string[];
  /** ISO timestamp, shown as a hover tooltip when known. */
  createdAt?: string;
}

export interface SiblingInfo {
  index: number; // 1-based position among sibling branches
  count: number;
}

interface ThreadProps {
  messages: ThreadMessage[];
  streaming: boolean;
  ephemeral: boolean;
  /** Changes when the visible conversation/branch changes → scroll snaps down. */
  threadKey: string;
  /** True while a conversation's messages are being fetched. */
  loading: boolean;
  /** Current bindings for the empty-state hint (rebindable in settings). */
  shortcutHints: { search: string; newChat: string };
  onReplay?(message: ThreadMessage): void;
  /** Branch pager info for a message (null → no siblings, hide the pager). */
  siblingInfo(m: ThreadMessage): SiblingInfo | null;
  onSiblingNav(m: ThreadMessage, direction: -1 | 1): void;
  onRegenerate(m: ThreadMessage): void;
  onEditSubmit(m: ThreadMessage, newText: string): void;
  onFeedback(m: ThreadMessage, rating: 'up' | 'down' | null, comment?: string): void;
}

/* ---- Claude-style activity flow: one row per step, pointer on the live one ---- */

const STEP_ICONS: Record<ChatStep['kind'], typeof GitBranch> = {
  route: GitBranch,
  think: Sparkles,
  tool: Wrench,
  write: PenLine,
};

function StepFlow({ steps, streaming }: { steps: ChatStep[]; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const open = streaming || expanded;
  const tools = steps.filter((s) => s.kind === 'tool');
  const failed = steps.some((s) => s.status === 'failed');

  if (!open) {
    return (
      <button className="stepflow-summary" onClick={() => setExpanded(true)} title="Show run steps">
        <ChevronRight size={13} className="stepflow-chevron" />
        {failed ? <X size={12} className="step-failed-ico" /> : <Check size={12} className="step-done-ico" />}
        {steps.length} step{steps.length === 1 ? '' : 's'}
        {tools.length > 0 && <span className="stepflow-tools">· {tools.map((t) => t.label.replace('Using ', '')).join(', ')}</span>}
      </button>
    );
  }

  return (
    <div className="stepflow">
      {!streaming && (
        <button className="stepflow-summary open" onClick={() => setExpanded(false)} title="Hide run steps">
          <ChevronRight size={13} className="stepflow-chevron rot" />
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </button>
      )}
      <div className="stepflow-list">
        {steps.map((s) => {
          const Icon = STEP_ICONS[s.kind];
          const current = s.status === 'running';
          return (
            <div key={s.id} className={`step ${s.status}${current ? ' current' : ''}`}>
              <span className="step-pointer" aria-hidden>
                <ChevronRight size={12} />
              </span>
              <span className="step-status">
                {s.status === 'running' ? (
                  <Loader2 size={12} className="spin" />
                ) : s.status === 'done' ? (
                  <Check size={12} />
                ) : (
                  <X size={12} />
                )}
              </span>
              <span className="step-icon">
                <Icon size={12} />
              </span>
              <span className="step-label">{s.label}</span>
              {s.detail && <span className="step-detail">{s.detail}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Hover-toolbar building blocks ---- */

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="msg-action"
      title={label}
      aria-label={label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function SiblingPager({
  info,
  onNav,
  disabled,
}: {
  info: SiblingInfo;
  onNav(direction: -1 | 1): void;
  disabled: boolean;
}) {
  return (
    <span className="branch-pager" title="Alternate versions of this message">
      <button
        type="button"
        aria-label="Previous version"
        disabled={disabled || info.index <= 1}
        onClick={(e) => {
          e.stopPropagation();
          onNav(-1);
        }}
      >
        <ChevronLeft size={12} />
      </button>
      <span className="branch-count">
        {info.index}/{info.count}
      </span>
      <button
        type="button"
        aria-label="Next version"
        disabled={disabled || info.index >= info.count}
        onClick={(e) => {
          e.stopPropagation();
          onNav(1);
        }}
      >
        <ChevronRight size={12} />
      </button>
    </span>
  );
}

function AttachmentChips({ attachments }: { attachments: AttachmentMeta[] }) {
  return (
    <div className="msg-attachments">
      {attachments.map((a, i) => (
        <span key={`${a.name}-${i}`} className="attachment-chip static">
          <Paperclip size={11} />
          <span className="attachment-chip-name">{a.name}</span>
          <span className="attachment-chip-kind">{a.kind}</span>
        </span>
      ))}
    </div>
  );
}

export function MessageThread({
  messages,
  streaming,
  ephemeral,
  threadKey,
  loading,
  shortcutHints,
  onReplay,
  siblingInfo,
  onSiblingNav,
  onRegenerate,
  onEditSubmit,
  onFeedback,
}: ThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const prevKeyRef = useRef(threadKey);
  const prevCountRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [commentFor, setCommentFor] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    nearBottomRef.current = true;
    setShowJump(false);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    nearBottomRef.current = near;
    setShowJump(!near && el.scrollHeight > el.clientHeight + 160);
  };

  /**
   * Follow the stream only while the user is at the bottom - scrolling up to
   * re-read must never be yanked back down by incoming tokens. Switching
   * conversations or sending a new message always snaps to the latest.
   */
  useEffect(() => {
    const switched = prevKeyRef.current !== threadKey;
    prevKeyRef.current = threadKey;
    const appended = messages.length > prevCountRef.current;
    prevCountRef.current = messages.length;
    if (switched) {
      scrollToBottom('auto');
      return;
    }
    const isNewTurn =
      appended &&
      (messages[messages.length - 1]?.role === 'user' || messages[messages.length - 2]?.role === 'user');
    if (nearBottomRef.current || isNewTurn) scrollToBottom('auto');
  }, [messages, threadKey]);

  if (loading) {
    return (
      <div className="thread" aria-busy="true" aria-label="Loading conversation">
        <div className="thread-inner">
          <div className="msg user"><div className="skel skel-user" /></div>
          <div className="msg"><div className="skel skel-assistant" /></div>
          <div className="msg user"><div className="skel skel-user short" /></div>
          <div className="msg"><div className="skel skel-assistant short" /></div>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="thread">
        <div className="thread-empty">
          <MessagesSquare size={28} />
          <div className="text-heading">How can the agents help?</div>
          <div className="text-meta">
            Ask anything - a router sends your request to the Generic, Coding, or Financial agent.
            Attach files or paste screenshots, dictate with the mic, and open <strong>Prompts</strong> below
            for ideas. <kbd>{shortcutHints.search}</kbd> searches history · <kbd>{shortcutHints.newChat}</kbd> new
            chat.
          </div>
          {ephemeral && (
            <div className="thread-empty-ephemeral">
              <Ghost size={13} /> Incognito is on - this conversation will not be saved.
            </div>
          )}
        </div>
      </div>
    );
  }

  const startEdit = (m: ThreadMessage) => {
    setEditingId(m.localId);
    setDraft(m.content);
  };
  const submitEdit = (m: ThreadMessage) => {
    const text = draft.trim();
    setEditingId(null);
    if (text && text !== m.content) onEditSubmit(m, text);
  };

  return (
    <div className="thread" ref={scrollRef} onScroll={onScroll} aria-label="Conversation">
      <div className="thread-inner">
        {ephemeral && (
          <div className="ephemeral-banner">
            <Ghost size={13} /> Incognito chat - messages are not saved and memory stays off.
          </div>
        )}
        {messages.map((m) => {
          const siblings = siblingInfo(m);
          return m.role === 'user' ? (
            <div key={m.localId} className="msg user">
              {editingId === m.localId ? (
                <div className="msg-edit">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={Math.min(8, Math.max(2, draft.split('\n').length))}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        submitEdit(m);
                      }
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                  <div className="msg-edit-actions">
                    <span className="msg-edit-hint">Sends as a new branch - the original stays reachable via ◀ ▶</span>
                    <button type="button" className="btn ghost sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                    <button type="button" className="btn primary sm" onClick={() => submitEdit(m)} disabled={!draft.trim()}>
                      Send
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {m.attachments && m.attachments.length > 0 && <AttachmentChips attachments={m.attachments} />}
                  <div
                    className="msg-bubble-user"
                    title={m.createdAt ? new Date(m.createdAt).toLocaleString() : undefined}
                  >
                    {m.content}
                  </div>
                  <div className="msg-actions user-actions">
                    {siblings && <SiblingPager info={siblings} onNav={(d) => onSiblingNav(m, d)} disabled={streaming} />}
                    <CopyButton text={m.content} label="Copy message" />
                    {!ephemeral && m.msgId && (
                      <button
                        type="button"
                        className="msg-action"
                        title="Edit and branch"
                        aria-label="Edit message"
                        disabled={streaming}
                        onClick={() => startEdit(m)}
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div key={m.localId} className="msg">
              <div
                className={`msg-card${m.run && !m.streaming ? ' replayable' : ''}`}
                onClick={() => {
                  // pressing the bubble replays its run - unless the user is selecting text
                  if (!m.run || m.streaming) return;
                  if (window.getSelection()?.toString()) return;
                  onReplay?.(m);
                }}
                title={m.run && !m.streaming ? 'Replay this run in the pipeline' : undefined}
              >
                <div className="msg-head">
                  <span
                    className="pill agent"
                    title={m.createdAt ? new Date(m.createdAt).toLocaleString() : undefined}
                  >
                    <Bot size={12} />
                    {m.agentId ? AGENT_LABELS[m.agentId] : 'Routing…'}
                    <span className="dot" />
                  </span>
                  {m.truncated && <span className="msg-truncated">response was interrupted</span>}
                  {m.run && !m.streaming && (
                    <button
                      className="msg-replay"
                      onClick={(e) => {
                        e.stopPropagation();
                        onReplay?.(m);
                      }}
                      aria-label="Replay this run in the pipeline"
                      title="Replay this run in the pipeline"
                    >
                      <Play size={11} />
                      Replay
                    </button>
                  )}
                </div>

                {m.steps && m.steps.length > 0 && <StepFlow steps={m.steps} streaming={m.streaming} />}

                {m.content ? (
                  <div className="msg-body">
                    <Markdown>{m.content}</Markdown>
                  </div>
                ) : m.streaming ? (
                  <div className="bubble-typing">
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                  </div>
                ) : null}

                {m.error && (
                  <div className="insp-error">
                    <span>{m.error}</span>
                    <button
                      type="button"
                      className="insp-retry"
                      disabled={streaming}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRegenerate(m);
                      }}
                    >
                      <RefreshCw size={12} /> Try again
                    </button>
                  </div>
                )}

                {m.memorySaved && m.memorySaved.length > 0 && (
                  <div className="memory-chip" title={m.memorySaved.join('\n')}>
                    <Sparkles size={12} /> Memory updated
                  </div>
                )}

                {!m.streaming && (
                  <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
                    {siblings && <SiblingPager info={siblings} onNav={(d) => onSiblingNav(m, d)} disabled={streaming} />}
                    <CopyButton text={m.content} label="Copy response" />
                    {!ephemeral && (
                      <button
                        type="button"
                        className="msg-action"
                        title="Regenerate response"
                        aria-label="Regenerate response"
                        disabled={streaming}
                        onClick={() => onRegenerate(m)}
                      >
                        <RefreshCw size={13} />
                      </button>
                    )}
                    {!ephemeral && m.msgId && (
                      <>
                        <button
                          type="button"
                          className={`msg-action${m.feedback === 'up' ? ' active-up' : ''}`}
                          title="Good response"
                          aria-label="Good response"
                          onClick={() => onFeedback(m, m.feedback === 'up' ? null : 'up')}
                        >
                          <ThumbsUp size={13} />
                        </button>
                        <button
                          type="button"
                          className={`msg-action${m.feedback === 'down' ? ' active-down' : ''}`}
                          title="Bad response"
                          aria-label="Bad response"
                          onClick={() => {
                            const clearing = m.feedback === 'down';
                            onFeedback(m, clearing ? null : 'down');
                            setCommentFor(clearing ? null : m.localId);
                            setComment('');
                          }}
                        >
                          <ThumbsDown size={13} />
                        </button>
                      </>
                    )}
                  </div>
                )}

                {commentFor === m.localId && (
                  <div className="feedback-comment" onClick={(e) => e.stopPropagation()}>
                    <input
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="What went wrong? (optional)"
                      maxLength={1000}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          onFeedback(m, 'down', comment.trim());
                          setCommentFor(null);
                        }
                        if (e.key === 'Escape') setCommentFor(null);
                      }}
                    />
                    <button
                      type="button"
                      className="btn secondary sm"
                      onClick={() => {
                        if (comment.trim()) onFeedback(m, 'down', comment.trim());
                        setCommentFor(null);
                      }}
                    >
                      {comment.trim() ? 'Send' : 'Dismiss'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {showJump && (
        <div className="jump-bottom-wrap">
          <button
            type="button"
            className="jump-bottom"
            onClick={() => scrollToBottom('smooth')}
            aria-label="Jump to the latest message"
          >
            <ArrowDown size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
