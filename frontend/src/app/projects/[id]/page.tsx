'use client';

import { Folder, Menu, Pencil, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Composer, type ComposerHandle } from '@/components/Composer';
import { ConfirmModal } from '@/components/ConfirmModal';
import { ConversationRail } from '@/components/ConversationRail';
import { ProjectModal } from '@/components/ProjectModal';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { setPendingChat } from '@/lib/handoff';
import { DEFAULT_SHORTCUTS, formatBinding, loadShortcuts } from '@/lib/shortcuts';
import type { Project, Strictness } from '@/lib/types';
import { AGENT_LABELS } from '@/lib/types';
import { useChatData } from '@/lib/use-chat-data';

const STRICTNESS_KEY = 'assistant.strictness';

/** Dedicated project page (like claude.ai): hero, composer, chats, instructions. */
export default function ProjectPage() {
  const { status, user, logout } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const data = useChatData(status === 'authed');
  const [project, setProject] = useState<Project | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [projectModal, setProjectModal] = useState<{ open: boolean; project: Project | null }>({
    open: false,
    project: null,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [strictness, setStrictnessState] = useState<Strictness>('balanced');
  const composerRef = useRef<ComposerHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === 'anon') router.replace('/login');
  }, [status, router]);

  useEffect(() => {
    if (status !== 'authed') return;
    apiFetch<{ project: Project }>(`/projects/${projectId}`)
      .then((d) => setProject(d.project))
      .catch(() => router.replace('/projects')); // gone or not yours
  }, [status, projectId, router]);

  // Same persisted answer-style preference as the chat page.
  useEffect(() => {
    const saved = localStorage.getItem(STRICTNESS_KEY);
    if (saved === 'strict' || saved === 'balanced' || saved === 'creative') setStrictnessState(saved);
    composerRef.current?.focus();
  }, []);
  const setStrictness = (s: Strictness) => {
    setStrictnessState(s);
    localStorage.setItem(STRICTNESS_KEY, s);
  };

  const [searchShortcutLabel, setSearchShortcutLabel] = useState(formatBinding(DEFAULT_SHORTCUTS.search));
  useEffect(() => setSearchShortcutLabel(formatBinding(loadShortcuts().search)), []);

  if (status !== 'authed' || !user) return null;

  const chats = data.conversations
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));

  async function onSaveProject(draft: { name: string; description: string; instructions: string }) {
    const editing = projectModal.project;
    const saved = await data.saveProject(editing, draft);
    if (!editing) router.push(`/projects/${saved.projectId}`);
    else if (editing.projectId === projectId) setProject(saved);
  }

  function onDeleteProject(id: string) {
    data.deleteProject(id);
    if (id === projectId) router.replace('/projects');
  }

  return (
    <div className="app">
      <div className="chat-body">
        {railOpen && <div className="scrim scrim-rail" onClick={() => setRailOpen(false)} aria-hidden="true" />}
        <ConversationRail
          ref={searchRef}
          conversations={data.conversations}
          projects={data.projects}
          activeId={null}
          activeNav="projects"
          open={railOpen}
          email={user.email}
          loading={data.loading}
          searchShortcutLabel={searchShortcutLabel}
          onSelect={(id) => router.push(`/chat?c=${id}`)}
          onNew={() => router.push('/chat')}
          onOpenChats={() => router.push('/chats')}
          onOpenProjects={() => router.push('/projects')}
          onRename={data.renameConversation}
          onDelete={data.deleteConversation}
          onStar={data.toggleStar}
          onLogout={() => { logout(); router.replace('/login'); }}
        />

        <main className="chat-pane project-page">
          <div className="page-topbar">
            <button className="icon-btn page-menu" onClick={() => setRailOpen((o) => !o)} aria-label="Toggle conversations">
              <Menu size={16} />
            </button>
            <button className="page-topbar-crumb crumb-link" onClick={() => router.push('/projects')}>
              Projects
            </button>
            {project && <span className="page-topbar-crumb-sep">/ {project.name}</span>}
          </div>

          {!project ? (
            <div className="project-loading">Loading project…</div>
          ) : (
            <div className="project-scroll">
              <div className="project-hero">
                <div className="project-hero-icon">
                  <Folder size={22} />
                </div>
                <div className="project-hero-text">
                  <h1>{project.name}</h1>
                  {project.description && <p>{project.description}</p>}
                </div>
                <div className="project-hero-actions">
                  <button
                    className="icon-btn sm"
                    title="Edit project"
                    aria-label="Edit project"
                    onClick={() => setProjectModal({ open: true, project })}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-btn sm danger"
                    title="Delete project"
                    aria-label="Delete project"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="project-composer">
                <Composer
                  ref={composerRef}
                  disabled={false}
                  streaming={false}
                  strictness={strictness}
                  ephemeral={false}
                  draftKey={`project:${projectId}`}
                  onStrictnessChange={setStrictness}
                  onSend={(text, attachments) => {
                    // Streaming lives on the chat page: hand the message over
                    // and let it create the conversation inside this project.
                    setPendingChat({ text, attachments, projectId });
                    router.push('/chat');
                  }}
                  onStop={() => undefined}
                />
              </div>

              <div className="project-columns">
                <section className="project-chats">
                  <h3>Chats in this project</h3>
                  {chats.length === 0 && (
                    <div className="project-chats-empty">
                      No chats yet - send a message above to start the first one.
                    </div>
                  )}
                  {chats.map((c) => (
                    <button key={c.convId} className="project-chat-row" onClick={() => router.push(`/chat?c=${c.convId}`)}>
                      <span className="project-chat-title">{c.title}</span>
                      <span className="project-chat-meta">
                        {c.lastAgentId ? AGENT_LABELS[c.lastAgentId] : '-'} ·{' '}
                        {new Date(c.lastMessageAt).toLocaleDateString()}
                      </span>
                    </button>
                  ))}
                </section>

                <aside className="project-side">
                  <div className="project-side-head">
                    <SlidersHorizontal size={13} />
                    <h3>Instructions</h3>
                    <button className="btn ghost sm" onClick={() => setProjectModal({ open: true, project })}>
                      <Pencil size={12} /> Edit
                    </button>
                  </div>
                  {project.instructions ? (
                    <p className="project-side-text">{project.instructions}</p>
                  ) : (
                    <p className="project-side-text muted">
                      No instructions yet. Add guidance the assistant should follow in every chat of this project.
                    </p>
                  )}
                </aside>
              </div>
            </div>
          )}
        </main>
      </div>

      <ProjectModal
        open={projectModal.open}
        project={projectModal.project}
        onSave={onSaveProject}
        onClose={() => setProjectModal({ open: false, project: null })}
      />
      <ConfirmModal
        open={confirmDelete}
        title="Delete project?"
        message="The project will be deleted. Its chats are kept and move back to your regular history."
        confirmLabel="Delete project"
        onConfirm={() => {
          setConfirmDelete(false);
          onDeleteProject(projectId);
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
