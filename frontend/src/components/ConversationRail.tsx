'use client';

import {
  Check,
  ChevronsLeft,
  ChevronsRight,
  Folder,
  LogOut,
  MessagesSquare,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import { ConfirmModal } from '@/components/ConfirmModal';
import { apiFetch } from '@/lib/api';
import { groupByRecency } from '@/lib/dates';
import type { Conversation, Project, SearchResult } from '@/lib/types';
import { AGENT_LABELS } from '@/lib/types';

/** Sidebar shows this many recents; the full list lives on the Chats page. */
const RECENTS_LIMIT = 20;

interface Props {
  conversations: Conversation[];
  projects: Project[];
  activeId: string | null;
  /** Which top-level nav tile the current page belongs to (highlights it). */
  activeNav?: 'chats' | 'projects' | null;
  open: boolean;
  email: string;
  /** True during the initial conversations fetch (renders skeleton rows). */
  loading: boolean;
  /** Current search shortcut, shown in the placeholder (rebindable in settings). */
  searchShortcutLabel: string;
  onSelect(convId: string): void;
  onNew(): void;
  onOpenChats(): void;
  onOpenProjects(): void;
  onRename(convId: string, title: string): void;
  onDelete(convId: string): void;
  onStar(convId: string): void;
  onLogout(): void;
}

const COLLAPSED_KEY = 'rail.collapsed';

/** "jane.doe@x.com" → "JD"; single-word local parts fall back to two letters. */
function emailInitials(email: string): string {
  const parts = email.split('@')[0]?.split(/[^a-zA-Z0-9]+/).filter(Boolean) ?? [];
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return (parts[0] ?? email).slice(0, 2).toUpperCase();
}

export const ConversationRail = forwardRef<HTMLInputElement, Props>(function ConversationRail(
  {
    conversations,
    projects,
    activeId,
    activeNav = null,
    open,
    email,
    loading,
    searchShortcutLabel,
    onSelect,
    onNew,
    onOpenChats,
    onOpenProjects,
    onRename,
    onDelete,
    onStar,
    onLogout,
  },
  searchRef,
) {
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [contentHits, setContentHits] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // restore the persisted collapsed preference
  useEffect(() => {
    if (localStorage.getItem(COLLAPSED_KEY) === '1') setCollapsed(true);
  }, []);
  const toggleCollapsed = (next: boolean) => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
  };

  // opening the mobile drawer always shows the full rail
  useEffect(() => {
    if (open) setCollapsed(false);
  }, [open]);

  // Debounced server-side content search; title filtering is instant + local.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setContentHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const d = await apiFetch<{ results: SearchResult[] }>(
          `/conversations/search?q=${encodeURIComponent(q)}`,
        );
        setContentHits(d.results.filter((r) => r.matchedIn === 'message'));
      } catch {
        setContentHits([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  if (collapsed) {
    return (
      <nav className={`rail collapsed${open ? ' open' : ''}`}>
        <button
          className="rail-expand"
          onClick={() => toggleCollapsed(false)}
          aria-label="Expand conversations"
          title="Expand conversations"
        >
          <ChevronsRight size={16} />
          <span className="rail-expand-label">Conversations</span>
        </button>
      </nav>
    );
  }

  const q = query.trim().toLowerCase();
  const titleMatches = q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : [];
  const titleMatchIds = new Set(titleMatches.map((c) => c.convId));
  const extraHits = contentHits.filter((r) => !titleMatchIds.has(r.convId));

  const starred = conversations.filter((c) => c.starred);
  const recents = conversations.filter((c) => !c.starred).slice(0, RECENTS_LIMIT);
  const recentGroups = groupByRecency(recents, (c) => c.lastMessageAt);
  const moreRecents = conversations.filter((c) => !c.starred).length - recents.length;
  const projectName = (projectId?: string) =>
    projectId ? projects.find((p) => p.projectId === projectId)?.name : undefined;

  const startRename = (c: Conversation) => {
    setRenamingId(c.convId);
    setRenameDraft(c.title);
  };
  const submitRename = () => {
    const title = renameDraft.trim();
    if (renamingId && title) onRename(renamingId, title);
    setRenamingId(null);
  };

  const renderConversation = (c: Conversation) =>
    renamingId === c.convId ? (
      <div key={c.convId} className="rail-item renaming">
        <input
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          maxLength={80}
          autoFocus
          aria-label="Conversation title"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRename();
            if (e.key === 'Escape') setRenamingId(null);
          }}
        />
        <div className="rail-item-actions visible">
          <button type="button" aria-label="Save title" onClick={submitRename}>
            <Check size={13} />
          </button>
          <button type="button" aria-label="Cancel rename" onClick={() => setRenamingId(null)}>
            <X size={13} />
          </button>
        </div>
      </div>
    ) : (
      <div key={c.convId} className={`rail-item${c.convId === activeId ? ' active' : ''}`}>
        <button className="rail-item-main" title={c.title} onClick={() => onSelect(c.convId)}>
          <span className="rail-item-title">{c.title}</span>
          <span className="rail-item-meta">
            {projectName(c.projectId) ?? (c.lastAgentId ? AGENT_LABELS[c.lastAgentId] : '-')} ·{' '}
            {new Date(c.lastMessageAt).toLocaleDateString()}
          </span>
        </button>
        <div className="rail-item-actions">
          <button
            type="button"
            aria-label={c.starred ? `Unstar ${c.title}` : `Star ${c.title}`}
            title={c.starred ? 'Unstar' : 'Star'}
            className={c.starred ? 'star-on' : ''}
            onClick={() => onStar(c.convId)}
          >
            <Star size={13} {...(c.starred ? { fill: 'currentColor' } : {})} />
          </button>
          <button type="button" aria-label={`Rename ${c.title}`} title="Rename" onClick={() => startRename(c)}>
            <Pencil size={13} />
          </button>
          <button
            type="button"
            aria-label={`Delete ${c.title}`}
            title="Delete"
            className="danger"
            onClick={() => setDeleteId(c.convId)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    );

  return (
    <nav className={`rail${open ? ' open' : ''}`}>
      <div className="rail-head">
        <h2>Conversations</h2>
        <button
          className="icon-btn rail-collapse"
          onClick={() => toggleCollapsed(true)}
          aria-label="Collapse conversations"
          title="Collapse conversations"
        >
          <ChevronsLeft size={15} />
        </button>
      </div>

      <div className="rail-search">
        <Search size={13} />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search conversations… (${searchShortcutLabel})`}
          aria-label="Search conversations"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
            <X size={12} />
          </button>
        )}
      </div>

      <div className="rail-list">
        {q ? (
          <>
            {titleMatches.length === 0 && extraHits.length === 0 && !searching && (
              <div className="rail-empty">No matches for “{query.trim()}”</div>
            )}
            {titleMatches.map(renderConversation)}
            {extraHits.length > 0 && (
              <>
                <div className="rail-section-label">Found in messages</div>
                {extraHits.map((r) => (
                  <div key={r.convId} className={`rail-item${r.convId === activeId ? ' active' : ''}`}>
                    <button className="rail-item-main" onClick={() => onSelect(r.convId)}>
                      <span className="rail-item-title">{r.title}</span>
                      {r.snippet && <span className="rail-item-snippet">{r.snippet}</span>}
                    </button>
                  </div>
                ))}
              </>
            )}
            {searching && <div className="rail-searching">Searching message content…</div>}
          </>
        ) : (
          <>
            {/* Top-level nav tiles (like claude.ai): each opens its own page */}
            <button className="rail-nav-item rail-new-chat" onClick={onNew}>
              <span className="rail-new-chat-icon">
                <Plus size={13} />
              </span>
              New chat
            </button>
            <button className={`rail-nav-item${activeNav === 'chats' ? ' active' : ''}`} onClick={onOpenChats}>
              <MessagesSquare size={14} /> Chats
              <span className="rail-nav-count">{conversations.length}</span>
            </button>
            <button className={`rail-nav-item${activeNav === 'projects' ? ' active' : ''}`} onClick={onOpenProjects}>
              <Folder size={14} /> Projects
              <span className="rail-nav-count">{projects.length}</span>
            </button>

            {starred.length > 0 && (
              <>
                <div className="rail-section-label">Starred</div>
                {starred.map(renderConversation)}
              </>
            )}

            {loading && conversations.length === 0 && (
              <div aria-hidden>
                <div className="rail-section-label">Recents</div>
                <div className="rail-skel" />
                <div className="rail-skel" />
                <div className="rail-skel" />
              </div>
            )}
            {!loading && conversations.length === 0 && (
              <div className="rail-empty">No conversations yet - ask something!</div>
            )}
            {recentGroups.map((group) => (
              <div key={group.label}>
                <div className="rail-section-label">{group.label}</div>
                {group.items.map(renderConversation)}
              </div>
            ))}
            {moreRecents > 0 && (
              <button className="rail-nav-item rail-view-all" onClick={onOpenChats}>
                View all chats ({conversations.length})
              </button>
            )}
          </>
        )}
      </div>

      <div className="rail-foot">
        <span className="rail-avatar" aria-hidden>{emailInitials(email)}</span>
        <span className="rail-foot-email" title={email}>{email}</span>
        <button
          className="icon-btn sm"
          onClick={() => setConfirmLogout(true)}
          aria-label="Log out"
          title="Log out"
        >
          <LogOut size={14} />
        </button>
      </div>

      <ConfirmModal
        open={confirmLogout}
        title="Log out?"
        message={`You are signed in as ${email}. Are you sure you want to log out?`}
        confirmLabel="Log out"
        onConfirm={() => {
          setConfirmLogout(false);
          onLogout();
        }}
        onCancel={() => setConfirmLogout(false)}
      />
      <ConfirmModal
        open={deleteId !== null}
        title="Delete conversation?"
        message="The conversation and all of its messages will be permanently deleted."
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleteId) onDelete(deleteId);
          setDeleteId(null);
        }}
        onCancel={() => setDeleteId(null)}
      />
    </nav>
  );
});
