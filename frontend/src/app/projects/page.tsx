'use client';

import { Folder, FolderPlus, Menu, Pencil, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ConfirmModal } from '@/components/ConfirmModal';
import { ConversationRail } from '@/components/ConversationRail';
import { ProjectModal } from '@/components/ProjectModal';
import { useAuth } from '@/lib/auth-context';
import { DEFAULT_SHORTCUTS, formatBinding, loadShortcuts } from '@/lib/shortcuts';
import type { Project } from '@/lib/types';
import { useChatData } from '@/lib/use-chat-data';

/** All projects as tiles (like claude.ai's Projects page); a tile opens its page. */
export default function ProjectsPage() {
  const { status, user, logout } = useAuth();
  const router = useRouter();

  const data = useChatData(status === 'authed');
  const [railOpen, setRailOpen] = useState(false);
  const [projectModal, setProjectModal] = useState<{ open: boolean; project: Project | null }>({
    open: false,
    project: null,
  });
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const railSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === 'anon') router.replace('/login');
  }, [status, router]);

  const [searchShortcutLabel, setSearchShortcutLabel] = useState(formatBinding(DEFAULT_SHORTCUTS.search));
  useEffect(() => setSearchShortcutLabel(formatBinding(loadShortcuts().search)), []);

  if (status !== 'authed' || !user) return null;

  const chatCount = (projectId: string) =>
    data.conversations.filter((c) => c.projectId === projectId).length;

  async function onSaveProject(draft: { name: string; description: string; instructions: string }) {
    const editing = projectModal.project;
    const saved = await data.saveProject(editing, draft);
    if (!editing) router.push(`/projects/${saved.projectId}`);
  }

  return (
    <div className="app">
      <div className="chat-body">
        {railOpen && <div className="scrim scrim-rail" onClick={() => setRailOpen(false)} aria-hidden="true" />}
        <ConversationRail
          ref={railSearchRef}
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
          onOpenProjects={() => undefined /* already here */}
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
            <span className="page-topbar-crumb">Projects</span>
            <button
              className="btn secondary sm history-new"
              onClick={() => setProjectModal({ open: true, project: null })}
            >
              <FolderPlus size={13} /> New project
            </button>
          </div>

          <div className="history-scroll">
            <h1 className="history-title">Your projects</h1>

            <p className="history-count">
              {data.projects.length} project{data.projects.length === 1 ? '' : 's'}
            </p>

            {data.projects.length === 0 && (
              <div className="history-empty">
                No projects yet. Group chats with shared instructions - just like Claude.
              </div>
            )}

            <div className="projects-grid">
              {data.projects.map((p) => (
                <div key={p.projectId} className="project-tile">
                  <button
                    className="project-tile-main"
                    onClick={() => router.push(`/projects/${p.projectId}`)}
                    title={p.name}
                  >
                    <span className="project-tile-icon">
                      <Folder size={16} />
                    </span>
                    <span className="project-tile-name">{p.name}</span>
                    {p.description && <span className="project-tile-desc">{p.description}</span>}
                    <span className="project-tile-meta">
                      {chatCount(p.projectId)} chat{chatCount(p.projectId) === 1 ? '' : 's'} · updated{' '}
                      {new Date(p.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                  <div className="project-tile-actions">
                    <button
                      type="button"
                      aria-label={`Edit ${p.name}`}
                      title="Edit project"
                      onClick={() => setProjectModal({ open: true, project: p })}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="danger"
                      aria-label={`Delete ${p.name}`}
                      title="Delete project"
                      onClick={() => setDeleteId(p.projectId)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>

      <ProjectModal
        open={projectModal.open}
        project={projectModal.project}
        onSave={onSaveProject}
        onClose={() => setProjectModal({ open: false, project: null })}
      />
      <ConfirmModal
        open={deleteId !== null}
        title="Delete project?"
        message="The project will be deleted. Its chats are kept and move back to your regular history."
        confirmLabel="Delete project"
        onConfirm={() => {
          if (deleteId) data.deleteProject(deleteId);
          setDeleteId(null);
        }}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
