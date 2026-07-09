'use client';

import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Project } from '@/lib/types';

interface Props {
  open: boolean;
  /** Project being edited; null = create a new one. */
  project: Project | null;
  onSave(draft: { name: string; description: string; instructions: string }): Promise<void>;
  onClose(): void;
}

/**
 * Create/edit form for a project, laid out like claude.ai's "Create a project"
 * dialog: a name and a single goal box. The goal feeds both the project's
 * description (shown on tiles) and its instructions (injected into every chat).
 */
export function ProjectModal({ open, project, onSave, onClose }: Props) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // re-seed the drafts every time the modal opens
  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    // legacy projects may carry either; prefer the description, fall back to instructions
    setGoal(project?.description || project?.instructions || '');
    setError(null);
  }, [open, project]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const goalText = goal.trim();
      await onSave({
        name: name.trim(),
        description: goalText,
        instructions: goalText,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the project');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal project-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="project-modal-head">
          <h3 id="project-modal-title" className="project-modal-title">
            {project ? 'Edit project' : 'Create a project'}
          </h3>
          <button type="button" className="project-modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {error && <div className="insp-error">{error}</div>}
        <form
          className="project-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="project-field">
            <span>What are you working on?</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoFocus
              placeholder="Name your project"
            />
          </label>
          <label className="project-field">
            <span>What are you trying to achieve?</span>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              maxLength={4000}
              rows={4}
              placeholder="Describe your project, goals, subject, etc…"
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!name.trim() || saving}>
              {saving ? 'Saving…' : project ? 'Save changes' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
