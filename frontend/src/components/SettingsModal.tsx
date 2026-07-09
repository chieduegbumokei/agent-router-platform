'use client';

import {
  Brain,
  Check,
  Keyboard,
  Loader2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmModal } from '@/components/ConfirmModal';
import { apiFetch } from '@/lib/api';
import {
  bindingFromEvent,
  DEFAULT_SHORTCUTS,
  formatBinding,
  sameBinding,
  SHORTCUT_ACTIONS,
  validateBinding,
  type ShortcutAction,
  type ShortcutMap,
} from '@/lib/shortcuts';
import type { McpServer, MemoryItem, UserSettings } from '@/lib/types';

export type SettingsTab = 'personalization' | 'memory' | 'connectors' | 'privacy' | 'shortcuts';
type Tab = SettingsTab;

const TABS: Array<{ id: Tab; label: string; icon: typeof UserRound }> = [
  { id: 'personalization', label: 'Personalization', icon: UserRound },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'connectors', label: 'Connectors (MCP)', icon: Plug },
  { id: 'privacy', label: 'Privacy & data', icon: ShieldCheck },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
];

/** Quick-fill persona presets for the custom-instructions box. */
const PERSONAS: Array<{ label: string; text: string }> = [
  { label: 'Senior engineer', text: 'Always answer like a pragmatic senior software engineer: direct, technically precise, with trade-offs called out and production concerns in mind.' },
  { label: 'Concise', text: 'Keep every answer as short as possible. Lead with the answer, skip preamble and closing summaries.' },
  { label: 'Explain like I’m new', text: 'Assume I am new to the topic. Define jargon the first time you use it and prefer concrete examples over abstractions.' },
];

/** Non-editable keys: baked into the composer, menus, and stop-generation. */
const FIXED_SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: 'Enter', action: 'Send message' },
  { keys: 'Shift+Enter', action: 'New line in the composer' },
  { keys: 'Esc', action: 'Stop generating · close menus' },
];

interface Props {
  open: boolean;
  onClose(): void;
  shortcuts: ShortcutMap;
  onShortcutsChange(next: ShortcutMap): void;
  /** Lets the chat page keep its memory-toggle state in sync. */
  onSettingsChange?(settings: UserSettings): void;
  onConversationsCleared?(): void;
  /** Tab to land on when opened (e.g. deep-linked from the composer's Connectors menu). */
  initialTab?: Tab;
}

export function SettingsModal({
  open,
  onClose,
  shortcuts,
  onShortcutsChange,
  onSettingsChange,
  onConversationsCleared,
  initialTab,
}: Props) {
  const [tab, setTab] = useState<Tab>('personalization');
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [instructionsDraft, setInstructionsDraft] = useState('');
  const [saved, setSaved] = useState(false);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'memories' | 'conversations' | null>(null);

  // MCP add form
  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpToken, setMcpToken] = useState('');

  // Shortcut recording
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, m, c] = await Promise.all([
        apiFetch<{ settings: UserSettings }>('/settings'),
        apiFetch<{ memories: MemoryItem[] }>('/memories'),
        apiFetch<{ servers: McpServer[] }>('/mcp/servers'),
      ]);
      setSettings(s.settings);
      setInstructionsDraft(s.settings.customInstructions);
      setMemories(m.memories);
      setServers(c.servers);
    } catch {
      setError('Could not load settings - is the backend running?');
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (initialTab) setTab(initialTab);
    void load();
  }, [open, load, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Shortcut recorder: capture-phase so the app's own shortcut handler (and
  // the modal's Escape-to-close above) never see the keystroke being bound.
  useEffect(() => {
    if (!recordingAction) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecordingAction(null);
        return;
      }
      const binding = bindingFromEvent(e);
      if (!binding) return; // modifier still held down
      const invalid = validateBinding(binding);
      if (invalid) {
        setShortcutError(invalid);
        setRecordingAction(null);
        return;
      }
      const conflict = SHORTCUT_ACTIONS.find(
        (a) => a.id !== recordingAction && sameBinding(shortcuts[a.id], binding),
      );
      if (conflict) {
        setShortcutError(`${formatBinding(binding)} is already used by “${conflict.label}”`);
        setRecordingAction(null);
        return;
      }
      onShortcutsChange({ ...shortcuts, [recordingAction]: binding });
      setShortcutError(null);
      setRecordingAction(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recordingAction, shortcuts, onShortcutsChange]);

  // Leaving the tab or closing the modal abandons any in-progress recording.
  useEffect(() => {
    if (!open || tab !== 'shortcuts') {
      setRecordingAction(null);
      setShortcutError(null);
    }
  }, [open, tab]);

  if (!open) return null;

  const fail = (message: string) => {
    setError(message);
    setTimeout(() => setError(null), 4000);
  };

  async function patchSettings(patch: Partial<UserSettings>) {
    try {
      const d = await apiFetch<{ settings: UserSettings }>('/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setSettings(d.settings);
      onSettingsChange?.(d.settings);
      return true;
    } catch {
      fail('Saving settings failed');
      return false;
    }
  }

  async function saveInstructions() {
    setBusy('instructions');
    if (await patchSettings({ customInstructions: instructionsDraft })) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
    setBusy(null);
  }

  async function deleteMemory(memId: string) {
    setMemories((prev) => prev.filter((m) => m.memId !== memId)); // optimistic
    try {
      await apiFetch(`/memories/${memId}`, { method: 'DELETE' });
    } catch {
      fail('Delete failed');
      void load();
    }
  }

  async function clearMemories() {
    setConfirm(null);
    setMemories([]);
    try {
      await apiFetch('/memories', { method: 'DELETE' });
    } catch {
      fail('Clearing memories failed');
      void load();
    }
  }

  async function clearConversations() {
    setConfirm(null);
    setBusy('clear-conversations');
    try {
      await apiFetch('/conversations', { method: 'DELETE' });
      onConversationsCleared?.();
    } catch {
      fail('Clearing conversations failed');
    }
    setBusy(null);
  }

  async function addServer() {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setBusy('mcp-add');
    try {
      const d = await apiFetch<{ server: McpServer }>('/mcp/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: mcpName.trim(),
          url: mcpUrl.trim(),
          ...(mcpToken.trim() ? { authToken: mcpToken.trim() } : {}),
        }),
      });
      setServers((prev) => [...prev, d.server]);
      setMcpName('');
      setMcpUrl('');
      setMcpToken('');
    } catch (err) {
      fail((err as Error).message || 'Could not connect to the MCP server');
    }
    setBusy(null);
  }

  async function serverAction(server: McpServer, action: 'refresh' | 'toggle' | 'delete') {
    setBusy(`mcp-${server.serverId}`);
    try {
      if (action === 'delete') {
        await apiFetch(`/mcp/servers/${server.serverId}`, { method: 'DELETE' });
        setServers((prev) => prev.filter((s) => s.serverId !== server.serverId));
      } else if (action === 'toggle') {
        const d = await apiFetch<{ server: McpServer }>(`/mcp/servers/${server.serverId}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !server.enabled }),
        });
        setServers((prev) => prev.map((s) => (s.serverId === server.serverId ? d.server : s)));
      } else {
        const d = await apiFetch<{ server: McpServer }>(`/mcp/servers/${server.serverId}/refresh`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        setServers((prev) => prev.map((s) => (s.serverId === server.serverId ? d.server : s)));
      }
    } catch (err) {
      fail((err as Error).message || 'Connector action failed');
    }
    setBusy(null);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <h3 id="settings-title" className="modal-title">Settings</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            <X size={15} />
          </button>
        </div>

        {error && <div className="insp-error settings-error">{error}</div>}

        <div className="settings-body">
          <nav className="settings-tabs" aria-label="Settings sections">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`settings-tab${tab === id ? ' active' : ''}`}
                onClick={() => setTab(id)}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {tab === 'personalization' && (
              <section>
                <h4>Custom instructions</h4>
                <p className="settings-hint">
                  Applied to every agent in every conversation - tone, role, standing context.
                </p>
                <div className="persona-chips">
                  {PERSONAS.map((p) => (
                    <button key={p.label} type="button" className="persona-chip" onClick={() => setInstructionsDraft(p.text)}>
                      <Sparkles size={11} /> {p.label}
                    </button>
                  ))}
                </div>
                <textarea
                  className="settings-textarea"
                  value={instructionsDraft}
                  onChange={(e) => setInstructionsDraft(e.target.value)}
                  maxLength={2000}
                  rows={6}
                  placeholder={'e.g. "Always answer like a senior engineer. I work mostly in TypeScript."'}
                />
                <div className="settings-row-end">
                  <span className="composer-count">{instructionsDraft.length} / 2,000</span>
                  <button
                    className="btn primary sm"
                    onClick={() => void saveInstructions()}
                    disabled={busy === 'instructions' || instructionsDraft === (settings?.customInstructions ?? '')}
                  >
                    {saved ? <Check size={13} /> : null} {saved ? 'Saved' : 'Save'}
                  </button>
                </div>
              </section>
            )}

            {tab === 'memory' && (
              <section>
                <div className="settings-toggle-row">
                  <div>
                    <h4>Cross-session memory</h4>
                    <p className="settings-hint">
                      The assistant remembers durable facts you share (role, preferences, projects) and
                      recalls them in later conversations. A “Memory updated” chip appears whenever
                      something is saved.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings?.memoryEnabled ?? true}
                    className={`toggle${settings?.memoryEnabled ? ' on' : ''}`}
                    onClick={() => void patchSettings({ memoryEnabled: !(settings?.memoryEnabled ?? true) })}
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>

                <div className="settings-list-head">
                  <h4>What the assistant remembers ({memories.length})</h4>
                  {memories.length > 0 && (
                    <button className="btn danger sm" onClick={() => setConfirm('memories')}>
                      <Trash2 size={13} /> Clear all
                    </button>
                  )}
                </div>
                {memories.length === 0 ? (
                  <p className="settings-hint">Nothing yet - share a preference in chat and it will show up here.</p>
                ) : (
                  <ul className="memory-list">
                    {memories.map((m) => (
                      <li key={m.memId}>
                        <span className="memory-content">{m.content}</span>
                        <span className="memory-date">{new Date(m.createdAt).toLocaleDateString()}</span>
                        <button
                          type="button"
                          aria-label="Forget this"
                          title="Forget this"
                          onClick={() => void deleteMemory(m.memId)}
                        >
                          <X size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {tab === 'connectors' && (
              <section>
                <h4>MCP connectors</h4>
                <p className="settings-hint">
                  Connect Model Context Protocol servers (Streamable HTTP) and every agent can use their
                  tools - calls show up in the pipeline and tool chips like built-in tools.
                </p>

                {servers.map((s) => (
                  <div key={s.serverId} className="mcp-card">
                    <div className="mcp-card-head">
                      <span className={`status-dot ${s.status === 'ok' ? 'completed' : 'failed'}`} />
                      <span className="mcp-name">{s.name}</span>
                      <span className="mcp-url" title={s.url}>{s.url}</span>
                      <div className="mcp-actions">
                        <button
                          type="button"
                          className={`toggle sm${s.enabled ? ' on' : ''}`}
                          role="switch"
                          aria-checked={s.enabled}
                          title={s.enabled ? 'Disable' : 'Enable'}
                          disabled={busy === `mcp-${s.serverId}`}
                          onClick={() => void serverAction(s, 'toggle')}
                        >
                          <span className="toggle-knob" />
                        </button>
                        <button
                          type="button"
                          className="icon-btn sm"
                          title="Re-check connection and tools"
                          aria-label="Refresh connector"
                          disabled={busy === `mcp-${s.serverId}`}
                          onClick={() => void serverAction(s, 'refresh')}
                        >
                          {busy === `mcp-${s.serverId}` ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                        </button>
                        <button
                          type="button"
                          className="icon-btn sm danger"
                          title="Remove connector"
                          aria-label="Remove connector"
                          onClick={() => void serverAction(s, 'delete')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    {s.status === 'error' ? (
                      <div className="mcp-error">{s.lastError ?? 'connection failed'}</div>
                    ) : (
                      <div className="mcp-tools">
                        {s.tools.length === 0
                          ? 'no tools exposed'
                          : s.tools.map((t) => (
                              <span key={t.name} className="mcp-tool-chip" title={t.description}>
                                {t.name}
                              </span>
                            ))}
                      </div>
                    )}
                  </div>
                ))}

                <div className="mcp-add">
                  <h4>Add a server</h4>
                  <div className="mcp-add-grid">
                    <input value={mcpName} onChange={(e) => setMcpName(e.target.value)} placeholder="Name (e.g. github)" maxLength={40} />
                    <input value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder="https://example.com/mcp" maxLength={500} />
                    <input value={mcpToken} onChange={(e) => setMcpToken(e.target.value)} placeholder="Bearer token (optional)" type="password" maxLength={2000} />
                    <button
                      className="btn primary sm"
                      onClick={() => void addServer()}
                      disabled={busy === 'mcp-add' || !mcpName.trim() || !mcpUrl.trim()}
                    >
                      {busy === 'mcp-add' ? <Loader2 size={13} className="spin" /> : <Plug size={13} />}
                      {busy === 'mcp-add' ? 'Connecting…' : 'Connect'}
                    </button>
                  </div>
                  <p className="settings-hint">
                    The connection is tested and tools are listed immediately; tokens are stored
                    server-side and never shown again.
                  </p>
                </div>
              </section>
            )}

            {tab === 'privacy' && (
              <section>
                <h4>Privacy & data</h4>
                <ul className="privacy-list">
                  <li>
                    <strong>Incognito chats</strong> (ghost icon in the top bar, or{' '}
                    {formatBinding(shortcuts.incognito)}) are never saved and never read or write memory.
                  </li>
                  <li>
                    <strong>Memory</strong> can be turned off entirely in the Memory tab - existing facts
                    stay until you delete them.
                  </li>
                  <li>
                    <strong>Feedback</strong> (👍/👎) is stored with the message it rates, nowhere else.
                  </li>
                </ul>
                <div className="settings-danger-zone">
                  <div className="settings-toggle-row">
                    <div>
                      <h4>Delete all conversations</h4>
                      <p className="settings-hint">Removes every conversation and message. Cannot be undone.</p>
                    </div>
                    <button
                      className="btn danger sm"
                      disabled={busy === 'clear-conversations'}
                      onClick={() => setConfirm('conversations')}
                    >
                      <Trash2 size={13} /> Delete all
                    </button>
                  </div>
                  <div className="settings-toggle-row">
                    <div>
                      <h4>Delete all memories</h4>
                      <p className="settings-hint">Forgets everything learned across conversations.</p>
                    </div>
                    <button className="btn danger sm" onClick={() => setConfirm('memories')}>
                      <Trash2 size={13} /> Delete all
                    </button>
                  </div>
                </div>
              </section>
            )}

            {tab === 'shortcuts' && (
              <section>
                <h4>Keyboard shortcuts</h4>
                <p className="settings-hint">
                  Click a binding, then press the new combination. Esc cancels recording.
                </p>
                {shortcutError && <div className="shortcut-error">{shortcutError}</div>}
                <table className="shortcuts-table">
                  <tbody>
                    {SHORTCUT_ACTIONS.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <button
                            type="button"
                            className={`shortcut-binding${recordingAction === a.id ? ' recording' : ''}`}
                            title="Click, then press the new key combination"
                            onClick={() => {
                              setShortcutError(null);
                              setRecordingAction(recordingAction === a.id ? null : a.id);
                            }}
                          >
                            {recordingAction === a.id ? 'Press keys…' : <kbd>{formatBinding(shortcuts[a.id])}</kbd>}
                          </button>
                        </td>
                        <td>{a.label}</td>
                      </tr>
                    ))}
                    {FIXED_SHORTCUTS.map((s) => (
                      <tr key={s.keys} className="shortcut-fixed">
                        <td><kbd>{s.keys}</kbd></td>
                        <td>
                          {s.action} <span className="shortcut-fixed-note">fixed</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="settings-row-end">
                  <button
                    type="button"
                    className="btn secondary sm"
                    onClick={() => {
                      onShortcutsChange(DEFAULT_SHORTCUTS);
                      setShortcutError(null);
                      setRecordingAction(null);
                    }}
                  >
                    Reset to defaults
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>

      <ConfirmModal
        open={confirm === 'memories'}
        title="Delete all memories?"
        message="The assistant will forget everything it has learned about you. This cannot be undone."
        confirmLabel="Delete all"
        onConfirm={() => void clearMemories()}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm === 'conversations'}
        title="Delete all conversations?"
        message="Every conversation and message will be permanently deleted. This cannot be undone."
        confirmLabel="Delete all"
        onConfirm={() => void clearConversations()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
