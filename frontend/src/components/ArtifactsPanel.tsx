'use client';

import { Check, Copy, Download, FileCode2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { artifactFileName, type Artifact } from '@/lib/artifacts';

/**
 * Artifacts drawer: substantial code blocks from assistant answers, kept out
 * of the chat scrollback. Content updates live while a response streams, so
 * iterating on a file shows in place instead of drowning the thread.
 */

interface Props {
  artifacts: Artifact[];
  open: boolean;
  onClose(): void;
}

export function ArtifactsPanel({ artifacts, open, onClose }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Follow the newest artifact unless the user explicitly picked another one.
  useEffect(() => {
    if (artifacts.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !artifacts.some((a) => a.id === selectedId)) {
      setSelectedId(artifacts[artifacts.length - 1]!.id);
    }
  }, [artifacts, selectedId]);

  if (!open) return null;

  const selected = artifacts.find((a) => a.id === selectedId) ?? artifacts[artifacts.length - 1];

  async function copy() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  function download() {
    if (!selected) return;
    const blob = new Blob([selected.code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = artifactFileName(selected);
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <aside className="artifacts-panel open" aria-label="Artifacts">
      <div className="pipeline-head">
        <h2>
          <FileCode2 size={14} /> Artifacts
        </h2>
        <div className="pipeline-head-right">
          {selected && (
            <>
              <button className="icon-btn sm" onClick={() => void copy()} title="Copy code" aria-label="Copy code">
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
              <button className="icon-btn sm" onClick={download} title="Download file" aria-label="Download file">
                <Download size={13} />
              </button>
            </>
          )}
          <button className="icon-btn sm" onClick={onClose} aria-label="Close artifacts">
            <X size={14} />
          </button>
        </div>
      </div>

      {artifacts.length === 0 ? (
        <div className="artifacts-empty">
          <FileCode2 size={22} />
          <p>
            Substantial code blocks from answers collect here - ask the Coding Agent to write
            something and it will appear as a tab.
          </p>
        </div>
      ) : (
        <>
          <div className="artifacts-tabs" role="tablist">
            {artifacts.map((a, i) => (
              <button
                key={a.id}
                role="tab"
                aria-selected={a.id === selected?.id}
                className={`artifacts-tab${a.id === selected?.id ? ' active' : ''}`}
                onClick={() => setSelectedId(a.id)}
                title={a.title}
              >
                {a.language} #{i + 1}
              </button>
            ))}
          </div>
          {selected && (
            <div className="artifacts-view">
              <div className="artifacts-meta">{selected.title}</div>
              <pre className="artifacts-code">
                <code>{selected.code}</code>
              </pre>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
