'use client';

import { Folder, Menu, Search, SquarePen, Star, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmModal } from '@/components/ConfirmModal';
import { ConversationRail } from '@/components/ConversationRail';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { groupByRecency, type RecencyGroup } from '@/lib/dates';
import { DEFAULT_SHORTCUTS, formatBinding, loadShortcuts } from '@/lib/shortcuts';
import type { Conversation, SearchResult } from '@/lib/types';
import { AGENT_LABELS } from '@/lib/types';
import { useChatData } from '@/lib/use-chat-data';

type GroupBy = 'none' | 'date' | 'project';
const GROUP_KEY = 'chats.groupBy';
const GROUP_OPTIONS: Array<{ id: GroupBy; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'date', label: 'Date' },
  { id: 'project', label: 'Project' },
];

/** Full chat history (like claude.ai's recents page): search, star, group. */
export default function ChatsPage() {
  const { status, user, logout } = useAuth();
  const router = useRouter();

  const data = useChatData(status === 'authed');
  const [railOpen, setRailOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [contentHits, setContentHits] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('date');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const railSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === 'anon') router.replace('/login');
  }, [status, router]);

  useEffect(() => {
    const saved = localStorage.getItem(GROUP_KEY);
    if (saved === 'none' || saved === 'date' || saved === 'project') setGroupBy(saved);
  }, []);
  const changeGroupBy = (g: GroupBy) => {
    setGroupBy(g);
    localStorage.setItem(GROUP_KEY, g);
  };

  // Debounced server-side content search (same contract as the sidebar).
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

  const [searchShortcutLabel, setSearchShortcutLabel] = useState(formatBinding(DEFAULT_SHORTCUTS.search));
  useEffect(() => setSearchShortcutLabel(formatBinding(loadShortcuts().search)), []);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (q ? data.conversations.filter((c) => c.title.toLowerCase().includes(q)) : data.conversations)
        .slice()
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
    [data.conversations, q],
  );
  const filteredIds = new Set(filtered.map((c) => c.convId));
  const extraHits = contentHits.filter((r) => !filteredIds.has(r.convId));

  const groups: Array<RecencyGroup<Conversation>> = useMemo(() => {
    if (groupBy === 'date') return groupByRecency(filtered, (c) => c.lastMessageAt);
    if (groupBy === 'project') {
      const byProject: Array<RecencyGroup<Conversation>> = data.projects
        .map((p) => ({
          label: p.name,
          items: filtered.filter((c) => c.projectId === p.projectId),
        }))
        .filter((g) => g.items.length > 0);
      const loose = filtered.filter(
        (c) => !c.projectId || !data.projects.some((p) => p.projectId === c.projectId),
      );
      return [...byProject, ...(loose.length ? [{ label: 'No project', items: loose }] : [])];
    }
    return [{ label: '', items: filtered }];
  }, [groupBy, filtered, data.projects]);

  if (status !== 'authed' || !user) return null;

  const projectName = (projectId?: string) =>
    projectId ? data.projects.find((p) => p.projectId === projectId)?.name : undefined;

  const renderRow = (c: Conversation) => (
    <div key={c.convId} className="history-row">
      <button className="history-row-main" onClick={() => router.push(`/chat?c=${c.convId}`)}>
        <span className="history-row-title">
          {c.starred && <Star size={12} fill="currentColor" className="history-star-mark" />}
          {c.title}
        </span>
        <span className="history-row-meta">
          {projectName(c.projectId) && groupBy !== 'project' && (
            <span className="history-project-chip">
              <Folder size={11} /> {projectName(c.projectId)}
            </span>
          )}
          {c.lastAgentId ? AGENT_LABELS[c.lastAgentId] : '-'} ·{' '}
          {new Date(c.lastMessageAt).toLocaleDateString()}
        </span>
      </button>
      <div className="history-row-actions">
        <button
          type="button"
          className={c.starred ? 'star-on' : ''}
          aria-label={c.starred ? `Unstar ${c.title}` : `Star ${c.title}`}
          title={c.starred ? 'Unstar' : 'Star'}
          onClick={() => data.toggleStar(c.convId)}
        >
          <Star size={14} {...(c.starred ? { fill: 'currentColor' } : {})} />
        </button>
        <button
          type="button"
          className="danger"
          aria-label={`Delete ${c.title}`}
          title="Delete"
          onClick={() => setDeleteId(c.convId)}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="app">
      <div className="chat-body">
        {railOpen && <div className="scrim scrim-rail" onClick={() => setRailOpen(false)} aria-hidden="true" />}
        <ConversationRail
          ref={railSearchRef}
          conversations={data.conversations}
          projects={data.projects}
          activeId={null}
          activeNav="chats"
          open={railOpen}
          email={user.email}
          loading={data.loading}
          searchShortcutLabel={searchShortcutLabel}
          onSelect={(id) => router.push(`/chat?c=${id}`)}
          onNew={() => router.push('/chat')}
          onOpenChats={() => undefined /* already here */}
          onOpenProjects={() => router.push('/projects')}
          onRename={data.renameConversation}
          onDelete={data.deleteConversation}
          onStar={data.toggleStar}
          onLogout={() => { logout(); router.replace('/login'); }}
        />

        <main className="chat-pane history-page">
          <div className="page-topbar">
            <button className="icon-btn page-menu" onClick={() => setRailOpen((o) => !o)} aria-label="Toggle conversations">
              <Menu size={16} />
            </button>
            <span className="page-topbar-crumb">Chats</span>
            <button className="btn secondary sm history-new" onClick={() => router.push('/chat')}>
              <SquarePen size={13} /> New chat
            </button>
          </div>

          <div className="history-scroll">
            <h1 className="history-title">Your chat history</h1>

            <div className="history-controls">
              <div className="history-search">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search your chats…"
                  aria-label="Search chats"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setQuery('');
                  }}
                />
                {query && (
                  <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
                    <X size={13} />
                  </button>
                )}
              </div>
              <div className="history-groupby" role="group" aria-label="Group chats by">
                <span>Group by</span>
                {GROUP_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    className={`history-group-btn${groupBy === o.id ? ' active' : ''}`}
                    onClick={() => changeGroupBy(o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="history-count">
              {filtered.length} chat{filtered.length === 1 ? '' : 's'}
              {q ? ` matching “${query.trim()}”` : ''}
            </p>

            {filtered.length === 0 && extraHits.length === 0 && !searching && (
              <div className="history-empty">
                {q ? `No matches for “${query.trim()}”` : 'No conversations yet - start one!'}
              </div>
            )}

            {groups.map((group) => (
              <section key={group.label || 'all'} className="history-group">
                {group.label && <h2 className="history-group-label">{group.label}</h2>}
                {group.items.map(renderRow)}
              </section>
            ))}

            {extraHits.length > 0 && (
              <section className="history-group">
                <h2 className="history-group-label">Found in messages</h2>
                {extraHits.map((r) => (
                  <div key={r.convId} className="history-row">
                    <button className="history-row-main" onClick={() => router.push(`/chat?c=${r.convId}`)}>
                      <span className="history-row-title">{r.title}</span>
                      {r.snippet && <span className="history-row-meta">{r.snippet}</span>}
                    </button>
                  </div>
                ))}
              </section>
            )}
            {searching && <div className="history-empty">Searching message content…</div>}
          </div>
        </main>
      </div>

      <ConfirmModal
        open={deleteId !== null}
        title="Delete conversation?"
        message="The conversation and all of its messages will be permanently deleted."
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleteId) data.deleteConversation(deleteId);
          setDeleteId(null);
        }}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
