'use client';

import { FileCode2, Ghost, PanelLeft, Settings, Workflow } from 'lucide-react';

interface Props {
  ephemeral: boolean;
  artifactCount: number;
  /** Current incognito shortcut, shown in the tooltip (rebindable in settings). */
  incognitoShortcutLabel: string;
  onToggleRail(): void;
  onTogglePipeline(): void;
  onToggleArtifacts(): void;
  onToggleEphemeral(): void;
  onOpenSettings(): void;
}

export function Topbar({
  ephemeral,
  artifactCount,
  incognitoShortcutLabel,
  onToggleRail,
  onTogglePipeline,
  onToggleArtifacts,
  onToggleEphemeral,
  onOpenSettings,
}: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <button className="icon-btn rail-toggle" onClick={onToggleRail} aria-label="Toggle conversations">
          <PanelLeft size={16} />
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="Cross River" className="brand-logo" />
        <span className="brand-sub">AI Assistant Platform</span>
      </div>
      <div className="topbar-right">
        <button
          className={`icon-btn${ephemeral ? ' toggled' : ''}`}
          onClick={onToggleEphemeral}
          aria-label={ephemeral ? 'Turn incognito off' : 'Start an incognito chat'}
          aria-pressed={ephemeral}
          title={
            ephemeral
              ? `Incognito on - nothing is saved (${incognitoShortcutLabel})`
              : `Incognito chat - nothing saved, no memory (${incognitoShortcutLabel})`
          }
        >
          <Ghost size={16} />
        </button>
        <button
          className="icon-btn artifacts-toggle"
          onClick={onToggleArtifacts}
          aria-label="Toggle artifacts"
          title="Artifacts - code from answers"
        >
          <FileCode2 size={16} />
          {artifactCount > 0 && <span className="badge">{artifactCount}</span>}
        </button>
        <button
          className="icon-btn pipeline-toggle"
          onClick={onTogglePipeline}
          aria-label="Toggle live pipeline"
          title="Live pipeline"
        >
          <Workflow size={16} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} aria-label="Open settings" title="Settings">
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
}
